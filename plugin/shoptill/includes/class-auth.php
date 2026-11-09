<?php
namespace ShopTill;

use WP_Application_Passwords;
use WP_Error;
use WP_REST_Request;
use WP_User;

defined( 'ABSPATH' ) || exit;

/**
 * Till login. Each signed-in device gets its own WordPress application password, so a lost
 * tablet can be revoked from the user's profile without touching their real password.
 */
final class Auth {

	const APP_ID       = '6d0c9a52-3f4e-4b0f-9a5e-5a8f2b1c7e11';
	const MAX_FAILURES = 10;
	const MAX_PER_IP   = 50;
	const LOCKOUT      = 15 * MINUTE_IN_SECONDS;
	const STALE        = 90 * DAY_IN_SECONDS;

	public static function init() {
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'confine_token' ), 10, 3 );
		add_action( 'wp_authenticate_application_password_errors', array( __CLASS__, 'refuse_xmlrpc' ), 10, 3 );
		// A password changed over a lost tablet or a cashier who left has to sign the tills out too.
		add_action( 'profile_update', array( __CLASS__, 'profile_updated' ), 10, 2 );
		add_action( 'wp_set_password', array( __CLASS__, 'password_set' ), 10, 3 );
	}

	public static function profile_updated( $user_id, $old_user = null ) {
		$user = get_userdata( $user_id );
		if ( $user && $old_user instanceof WP_User && $user->user_pass !== $old_user->user_pass ) {
			self::revoke( $user_id );
		}
	}

	public static function password_set( $password, $user_id, $old_user = null ) {
		// WordPress saves an unchanged password again when it moves it to a stronger hash at sign-in.
		if ( $old_user instanceof WP_User && wp_check_password( $password, $old_user->user_pass ) ) {
			return;
		}
		self::revoke( $user_id );
	}

	/**
	 * A till token is only good for the till's own API, so a stolen tablet can't be used to run the site.
	 */
	public static function confine_token( $result, $server, WP_REST_Request $request ) {
		if ( null === $result && is_multisite() && self::is_till_token() ) {
			return self::multisite_error( 403 );
		}
		if ( null === $result && self::is_till_token() && 0 !== strpos( ltrim( $request->get_route(), '/' ), Rest::NS . '/' ) ) {
			return new WP_Error( 'shoptill_token_scope', __( 'POS tokens only work with the POS.', 'shoptill' ), array( 'status' => 403 ) );
		}
		return $result;
	}

	public static function refuse_xmlrpc( WP_Error $error, $user, $item ) {
		if ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST && self::APP_ID === $item['app_id'] ) {
			$error->add( 'shoptill_token_scope', __( 'POS tokens only work with the POS.', 'shoptill' ) );
		}
	}

	private static function is_till_token() {
		$uuid = rest_get_authenticated_app_password();
		if ( ! $uuid ) {
			return false;
		}
		$password = WP_Application_Passwords::get_user_application_password( get_current_user_id(), $uuid );
		return $password && self::APP_ID === $password['app_id'];
	}

	public static function login( WP_REST_Request $request ) {
		// Application passwords are network-wide. A site-local plugin cannot confine them on sites
		// where it is absent, so do not issue credentials on an unsupported network installation.
		if ( is_multisite() ) {
			return self::multisite_error( 501 );
		}
		if ( ! wp_is_application_passwords_available() ) {
			return new WP_Error(
				'shoptill_app_passwords_unavailable',
				__( 'Application passwords are turned off on this site. They need HTTPS, and no security plugin blocking them.', 'shoptill' ),
				array( 'status' => 501 )
			);
		}

		// One attempt at a time from an address, so parallel guesses can't all read the count before any adds to it.
		return Orders::locked(
			'shoptill_login_' . md5( self::client_ip() ),
			static function () use ( $request ) {
				return self::attempt( $request );
			},
			__( 'Another sign-in from this device is being checked. Try again in a moment.', 'shoptill' )
		);
	}

	private static function multisite_error( $status ) {
		return new WP_Error( 'shoptill_multisite', __( 'ShopTill device sign-in is not supported on WordPress Multisite. Use a single-site installation and revoke any existing ShopTill application passwords before converting a site to Multisite.', 'shoptill' ), array( 'status' => $status ) );
	}

	private static function attempt( WP_REST_Request $request ) {
		// Per account from this address, plus a ceiling for the address so it can't walk through usernames.
		// An email address counts against the account it belongs to.
		$username = sanitize_user( Plugin::text( $request['username'] ) );
		$by_email = is_email( $username ) ? get_user_by( 'email', $username ) : false;
		$account  = $by_email ? $by_email->user_login : $username;
		$user_key = 'shoptill_login_' . md5( self::client_ip() . '|' . strtolower( $account ) );
		$ip_key   = 'shoptill_login_ip_' . md5( self::client_ip() );
		$failures = (int) get_transient( $user_key );
		$from_ip  = (int) get_transient( $ip_key );
		if ( $failures >= self::MAX_FAILURES || $from_ip >= self::MAX_PER_IP ) {
			return new WP_Error( 'shoptill_locked', __( 'Too many failed logins. Try again in 15 minutes.', 'shoptill' ), array( 'status' => 429 ) );
		}

		// wp_authenticate() accepts application passwords during REST requests; a till token must not mint more tokens.
		add_filter( 'application_password_is_api_request', '__return_false' );
		$user = wp_authenticate( Plugin::text( $request['username'] ), Plugin::text( $request['password'] ) );
		remove_filter( 'application_password_is_api_request', '__return_false' );

		if ( is_wp_error( $user ) || ! user_can( $user, Plugin::CAP_USE ) ) {
			set_transient( $user_key, $failures + 1, self::LOCKOUT );
			set_transient( $ip_key, $from_ip + 1, self::LOCKOUT );
			if ( is_wp_error( $user ) ) {
				return new WP_Error( 'shoptill_bad_login', __( 'Wrong username or password.', 'shoptill' ), array( 'status' => 401 ) );
			}
			return new WP_Error( 'shoptill_forbidden', __( 'This account is not allowed to use the POS.', 'shoptill' ), array( 'status' => 403 ) );
		}
		delete_transient( $user_key );
		// Cleared browser storage leaves a login behind that nothing will use again, and the list on the
		// user's profile has to stay short enough to find a lost tablet in.
		self::revoke( $user->ID, time() - self::STALE );

		$device  = sanitize_text_field( Plugin::text( $request['device'] ) );
		$created = WP_Application_Passwords::create_new_application_password(
			$user->ID,
			array(
				'name'   => $device ? sprintf( 'ShopTill POS (%s)', $device ) : 'ShopTill POS',
				'app_id' => self::APP_ID,
			)
		);
		if ( is_wp_error( $created ) ) {
			return $created;
		}

		wp_set_current_user( $user->ID );

		return array(
			'token' => base64_encode( $user->user_login . ':' . $created[0] ), // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
			'user'  => self::user_payload( $user ),
		);
	}

	/**
	 * Deletes a user's till logins, or only those last used before $before.
	 */
	private static function revoke( $user_id, $before = PHP_INT_MAX ) {
		foreach ( WP_Application_Passwords::get_user_application_passwords( $user_id ) as $password ) {
			$used = $password['last_used'] ? $password['last_used'] : $password['created'];
			if ( self::APP_ID === $password['app_id'] && $used < $before ) {
				WP_Application_Passwords::delete_application_password( $user_id, $password['uuid'] );
			}
		}
	}

	/**
	 * Deletes every till login. With the plugin off nothing confines them to the till's API, so they
	 * would be full application passwords.
	 */
	public static function revoke_all() {
		$users = get_users(
			array(
				'fields'   => 'ID',
				'meta_key' => WP_Application_Passwords::USERMETA_KEY_APPLICATION_PASSWORDS, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			)
		);
		foreach ( $users as $user_id ) {
			self::revoke( $user_id );
		}
	}

	public static function logout() {
		$uuid = rest_get_authenticated_app_password();
		if ( $uuid ) {
			WP_Application_Passwords::delete_application_password( get_current_user_id(), $uuid );
		}
		return array( 'ok' => true );
	}

	public static function user_payload( $user ) {
		return array(
			'id'                => $user->ID,
			'name'              => $user->display_name,
			'can_refund'        => user_can( $user, Plugin::CAP_REFUND ),
			// What edit_product maps to for a published product someone else created.
			'can_edit'          => user_can( $user, 'edit_others_products' ) && user_can( $user, 'edit_published_products' ),
			'can_manage_orders' => user_can( $user, 'edit_shop_orders' ),
			'can_edit_users'    => user_can( $user, 'edit_users' ),
		);
	}

	private static function client_ip() {
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}
}
