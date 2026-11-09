<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

/**
 * Serves the till at /pos on the shop's own domain, so it talks to the REST API same-origin and its
 * service worker can control the whole /pos/ scope.
 */
final class App {

	const QUERY_VAR = 'shoptill_app';

	public static function init() {
		add_action( 'init', array( __CLASS__, 'add_rewrite_rules' ) );
		add_filter( 'query_vars', array( __CLASS__, 'query_vars' ) );
		add_action( 'template_redirect', array( __CLASS__, 'serve' ), 0 );
		add_filter( 'redirect_canonical', array( __CLASS__, 'no_canonical_redirect' ) );
	}

	public static function add_rewrite_rules() {
		add_rewrite_rule( '^pos/(sw\.js|manifest\.webmanifest)$', 'index.php?' . self::QUERY_VAR . '=$matches[1]', 'top' );
		add_rewrite_rule( '^pos(/.*)?$', 'index.php?' . self::QUERY_VAR . '=index', 'top' );
	}

	public static function query_vars( $vars ) {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	public static function no_canonical_redirect( $redirect ) {
		return get_query_var( self::QUERY_VAR ) ? false : $redirect;
	}

	/**
	 * Whether the shop's permalinks are plain, so the till has no /pos/ address and lives on a query string.
	 */
	public static function plain_permalinks() {
		return '' === (string) get_option( 'permalink_structure' );
	}

	public static function url() {
		return self::plain_permalinks() ? self::file_url( 'index' ) : home_url( '/pos/' );
	}

	/**
	 * One of the files the till is made of, at an address that works with the shop's permalinks.
	 */
	private static function file_url( $what ) {
		return self::plain_permalinks() ? add_query_arg( self::QUERY_VAR, $what, home_url( '/' ) ) : home_url( '/pos/' . $what );
	}

	private static function build_dir() {
		return SHOPTILL_DIR . 'app/';
	}

	public static function serve() {
		$what = get_query_var( self::QUERY_VAR );
		if ( ! $what ) {
			return;
		}

		// The assets, the API and the service worker live on the home URL, and the service worker only
		// controls the till's own address, so the till is only served from there.
		$home = wp_parse_url( self::url() );
		$host = isset( $_SERVER['HTTP_HOST'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) ) : '';
		$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ), PHP_URL_PATH ) : '';
		if ( 'index' === $what ) {
			// With plain permalinks the till's address is the home page with a query string, and nothing else.
			$outside = self::plain_permalinks() ? '/' !== $path : strtolower( preg_replace( '/:\d+$/', '', $host ) ) !== strtolower( $home['host'] ) || 0 !== strpos( $path, $home['path'] );
			if ( $outside ) {
				wp_redirect( self::url(), 301 ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect
				exit;
			}
		}

		nocache_headers();
		header( 'X-Content-Type-Options: nosniff' );
		header( 'X-Robots-Tag: noindex, nofollow' );
		header( 'X-Frame-Options: SAMEORIGIN' );
		header( "Content-Security-Policy: frame-ancestors 'self'" );

		if ( 'sw.js' === $what ) {
			header( 'Content-Type: application/javascript; charset=utf-8' );
			header( 'Service-Worker-Allowed: ' . wp_parse_url( self::url(), PHP_URL_PATH ) );
			self::readfile( 'sw.js' );
		} elseif ( 'manifest.webmanifest' === $what ) {
			header( 'Content-Type: application/manifest+json; charset=utf-8' );
			echo wp_json_encode( self::manifest() );
		} else {
			header( 'Content-Type: text/html; charset=utf-8' );
			self::index();
		}
		exit;
	}

	private static function readfile( $name ) {
		$file = self::build_dir() . $name;
		if ( ! is_readable( $file ) ) {
			status_header( 404 );
			return;
		}
		readfile( $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile
	}

	private static function index() {
		$file = self::build_dir() . 'index.html';
		if ( ! is_readable( $file ) ) {
			status_header( 500 );
			echo esc_html__( 'The POS app has not been built. Run npm run build in the app folder.', 'shoptill' );
			return;
		}

		$config = array(
			'restRoot' => esc_url_raw( rest_url( Rest::NS . '/' ) ),
			'appUrl'   => self::url(),
			'swUrl'    => self::file_url( 'sw.js' ),
			'version'  => SHOPTILL_VERSION,
			'shopName' => self::shop_name(),
		);

		$html = file_get_contents( $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		$html = strtr(
			$html,
			array(
				'./assets/'                 => esc_url( plugins_url( 'app/assets/', SHOPTILL_FILE ) ),
				'./icon.svg'                => esc_url( plugins_url( 'app/icon.svg', SHOPTILL_FILE ) ),
				'/pos/manifest.webmanifest' => esc_url( self::file_url( 'manifest.webmanifest' ) ),
				'<title>POS</title>'        => '<title>' . esc_html( self::shop_name() ) . ' POS</title>',
			)
		);
		$html = str_replace(
			'</head>',
			'<script>window.SHOPTILL=' . wp_json_encode( $config ) . ';</script></head>',
			$html
		);
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	/**
	 * get_bloginfo() returns the name HTML-escaped, which shows as &amp; once it is escaped again or put in JSON.
	 */
	public static function shop_name() {
		return html_entity_decode( get_bloginfo( 'name' ), ENT_QUOTES, 'UTF-8' );
	}

	private static function manifest() {
		$dir = plugins_url( 'app/', SHOPTILL_FILE );
		return array(
			'name'             => self::shop_name() . ' POS',
			'short_name'       => 'POS',
			'start_url'        => self::url(),
			'scope'            => self::url(),
			'display'          => 'standalone',
			'orientation'      => 'any',
			'background_color' => '#111827',
			'theme_color'      => '#111827',
			'lang'             => str_replace('_', '-', determine_locale()),
			// PNGs, because Windows and Android install prompts want real sizes; the SVG stays
			// for browsers that scale it themselves. The maskable one keeps its contents inside
			// the safe zone, so Android's circular masks do not clip the receipt.
			'icons'            => array(
				array(
					'src'   => $dir . 'icon-192.png',
					'sizes' => '192x192',
					'type'  => 'image/png',
				),
				array(
					'src'   => $dir . 'icon-512.png',
					'sizes' => '512x512',
					'type'  => 'image/png',
				),
				array(
					'src'   => $dir . 'icon-maskable-512.png',
					'sizes' => '512x512',
					'type'  => 'image/png',
					'purpose' => 'maskable',
				),
				array(
					'src'   => $dir . 'icon.svg',
					'sizes' => 'any',
					'type'  => 'image/svg+xml',
					'purpose' => 'any',
				),
			),
		);
	}
}
