<?php
namespace ShopTill;

use Automattic\WooCommerce\Utilities\DiscountsUtil;
use Exception;
use WC_Coupon;
use WC_Discounts;
use WC_Order;
use WC_Order_Item_Product;
use WC_Order_Refund;
use WC_Tax;
use WP_Error;

defined( 'ABSPATH' ) || exit;

/**
 * Turns a till cart into a WooCommerce order.
 *
 * Cart line shape: { product_id?, name?, qty, price?, tax_class?, discount? }. `price` and `discount`
 * are in the shop's own price terms (tax inclusive when the shop enters prices with tax), per line.
 * A line without product_id is a custom sale item.
 */
final class Orders {

	const META_CLIENT_ID = '_shoptill_client_id';
	const META_PAYMENTS  = '_shoptill_payments';
	const META_PAID_DAY  = '_shoptill_paid_day';
	const META_REGISTER  = '_shoptill_register';
	const META_CASHIER   = '_shoptill_cashier';
	const META_REFUND_BY = '_shoptill_refund_method';
	const META_OFF_OWED  = '_shoptill_off_owed';
	const META_OFFLINE   = '_shoptill_offline';
	const META_REQUESTS  = '_shoptill_requests';
	const META_REQUEST   = '_shoptill_request';
	const META_ATTEMPT   = '_shoptill_attempt';
	const META_FULFIL    = '_shoptill_fulfil';

	// What a web order goes through while it is packed and handed over.
	const FULFIL_STATUSES = array( 'processing', 'on-hold', 'completed' );

	// Web checkout methods whose money arrives after the order, which the customer may bring to the till instead.
	const PAID_LATER_GATEWAYS = array( 'bacs', 'cheque', 'cod' );

	// A sale reaching the server this long after it was rung up was queued offline and has already been paid.
	const LATE_AFTER = 120;

	/**
	 * Validate coupons against a cart and report how much each one takes off each line, without saving anything.
	 */
	public static function preview( array $payload ) {
		$order = new WC_Order();
		$order->set_created_via( Plugin::SOURCE );
		$order->set_prices_include_tax( wc_prices_include_tax() );
		self::set_customer( $order, isset( $payload['customer_id'] ) ? (int) $payload['customer_id'] : 0 );

		$items = self::build_items( isset( $payload['lines'] ) ? (array) $payload['lines'] : array() );
		if ( is_wp_error( $items ) ) {
			return $items;
		}

		$location = self::base_location();
		foreach ( $items as $index => $item ) {
			// WC_Discounts keys lines by item ID, so unsaved items need distinct placeholder IDs.
			$item->set_id( $index + 1 );
			$item->calculate_taxes( $location );
			$order->add_item( $item );
		}

		// As in create_unlocked(): with tax-inclusive prices a minimum spend is checked against the order's tax too.
		$order->update_taxes();
		$discounts = new WC_Discounts( $order );
		$coupons   = array();
		foreach ( self::coupon_codes( $payload ) as $code ) {
			$coupon = new WC_Coupon( $code );
			$result = $coupon->get_id() ? $discounts->apply_coupon( $coupon ) : new WP_Error( 'invalid_coupon', sprintf( __( 'Coupon "%s" does not exist.', 'shoptill' ), $code ) );
			if ( is_wp_error( $result ) ) {
				return new WP_Error( 'shoptill_coupon', wp_strip_all_tags( $result->get_error_message() ), array( 'status' => 422, 'code' => $code ) );
			}
			$coupons[] = $coupon->get_code();
		}

		$by_coupon = $discounts->get_discounts_by_coupon();
		$by_item   = $discounts->get_discounts_by_item();
		$lines     = array();
		foreach ( $items as $index => $item ) {
			$lines[] = array( 'coupon_discount' => (float) ( $by_item[ $index + 1 ] ?? 0 ) );
		}

		return array(
			'coupons' => array_map(
				static function ( $code ) use ( $by_coupon ) {
					return array(
						'code'     => $code,
						'discount' => (float) ( $by_coupon[ $code ] ?? 0 ),
					);
				},
				$coupons
			),
			'lines'   => $lines,
		);
	}

	/**
	 * The coupon rules WooCommerce only checks in the cart, which a till sale never goes through.
	 * Thrown messages are what WooCommerce reports the coupon was refused with.
	 */
	public static function check_coupon( $valid, WC_Coupon $coupon, WC_Discounts $discounts ) {
		$order = $discounts->get_object();
		if ( ! $valid || ! Plugin::is_pos_order( $order ) ) {
			return $valid;
		}
		// WooCommerce also accepts the signed-in user's address, which here is the cashier's.
		$allowed = $coupon->get_email_restrictions();
		$email   = strtolower( $order->get_billing_email() );
		if ( $allowed && ( ! $email || ! DiscountsUtil::is_coupon_emails_allowed( array( $email ), $allowed ) ) ) {
			throw new Exception( $coupon->get_coupon_error( WC_Coupon::E_WC_COUPON_NOT_YOURS_REMOVED ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
		if ( $coupon->get_usage_limit_per_user() && ! $order->get_customer_id() && ! $email ) {
			/* translators: %s: coupon code */
			throw new Exception( sprintf( __( 'Coupon "%s" is limited per customer. Choose the customer first.', 'shoptill' ), $coupon->get_code() ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
		// Saved orders list their coupons; a preview's are only in the discounts worked out so far.
		$others = array_diff( array_merge( $order->get_coupon_codes(), array_keys( $discounts->get_discounts_by_coupon() ) ), array( $coupon->get_code() ) );
		foreach ( $others as $code ) {
			$other = new WC_Coupon( $code );
			if ( $other->get_individual_use() ) {
				throw new Exception( $other->get_coupon_error( WC_Coupon::E_WC_COUPON_ALREADY_APPLIED_INDIV_USE_ONLY ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			}
		}
		if ( $others && $coupon->get_individual_use() ) {
			/* translators: %s: coupon code */
			throw new Exception( sprintf( __( 'Coupon "%s" can only be used on its own.', 'shoptill' ), $coupon->get_code() ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
		return $valid;
	}

	/**
	 * Create and pay a POS order. Idempotent on client_id so an offline till can retry safely.
	 */
	public static function create( array $payload ) {
		$client_id = isset( $payload['client_id'] ) ? sanitize_text_field( $payload['client_id'] ) : '';
		if ( ! preg_match( '/^[A-Za-z0-9-]{8,64}$/', $client_id ) ) {
			return new WP_Error( 'shoptill_client_id', __( 'Missing or malformed client_id.', 'shoptill' ), array( 'status' => 400 ) );
		}

		// The lookup happens only once the lock is held: WP_Query caches results per request, so checking
		// before as well would hide an order a racing request has just saved.
		return self::locked(
			'shoptill_' . md5( $client_id ),
			static function () use ( $client_id, $payload ) {
				$existing = self::find_by_client_id( $client_id );
				if ( $existing && ! $existing->has_status( 'pending' ) ) {
					return $existing;
				}
				// A try that died after the order's first save left it pending, holding any coupon uses. One that died
				// in its last save left it pending on the legacy store, and without its client_id on HPOS.
				$dead = $existing ? $existing : self::find_by_client_id( $client_id, self::META_ATTEMPT );
				if ( $dead ) {
					self::discard( $dead );
				}
				$create = static function () use ( $client_id, $payload ) {
					return self::create_unlocked( $client_id, $payload );
				};
				// Two tills selling the last unit, or a coupon's last use, must not both pass the check.
				$contended = ! Settings::flag( 'allow_oversell', 'yes' ) || self::coupon_codes( $payload );
				return $contended ? self::locked( 'shoptill_stock', $create ) : $create();
			}
		);
	}

	/**
	 * Run $fn holding a MySQL named lock. The lock belongs to the connection, so it is released even if PHP dies.
	 * Anything read before the lock may be stale, so $fn loads what it needs itself.
	 */
	public static function locked( $name, callable $fn, $busy = '' ) {
		global $wpdb;
		// Named locks are server-wide, and other sites may share the database server.
		$name = substr( $wpdb->prefix . $name, 0, 64 );
		if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 10)', $name ) ) ) {
			return new WP_Error( 'shoptill_in_progress', $busy ? $busy : __( 'Another till is saving this right now. Try again in a moment.', 'shoptill' ), array( 'status' => 409 ) );
		}
		try {
			return $fn();
		} finally {
			$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $name ) );
		}
	}

	/**
	 * The payments the till took for an order, none for a web order it hasn't taken any on.
	 */
	public static function payments( WC_Order $order ) {
		return array_values( array_filter( (array) $order->get_meta( self::META_PAYMENTS ) ) );
	}

	/**
	 * What is still owed on an order: its total less what was paid and what refunds took off the debt.
	 */
	private static function balance( WC_Order $order, array $payments, $before_refund = PHP_INT_MAX ) {
		$decimals = wc_get_price_decimals();
		$paid     = array_sum( wp_list_pluck( $payments, 'amount' ) );
		foreach ( $order->get_refunds() as $refund ) {
			if ( $refund->get_id() < $before_refund ) {
				// One made in WooCommerce on an order still waiting for its money can only come off what is owed.
				$paid += $refund->get_meta( self::META_REGISTER ) ? (float) $refund->get_meta( self::META_OFF_OWED ) : (float) $refund->get_amount();
			}
		}
		return round( (float) $order->get_total() - $paid, $decimals );
	}

	/**
	 * How much of a refund came off what the order owed rather than being paid back.
	 */
	public static function off_owed( WC_Order_Refund $refund ) {
		if ( $refund->get_meta( self::META_REGISTER ) ) {
			return (float) $refund->get_meta( self::META_OFF_OWED );
		}
		$order = wc_get_order( $refund->get_parent_id() );
		if ( ! $order instanceof WC_Order ) {
			return 0.0;
		}
		$owed = self::balance( $order, self::payments( $order ), $refund->get_id() );
		return $owed > self::tolerance( $order ) ? min( (float) $refund->get_amount(), $owed ) : 0.0;
	}

	/**
	 * How far the till's maths may be off WooCommerce's: about a cent per line.
	 */
	public static function tolerance( WC_Order $order ) {
		$decimals = wc_get_price_decimals();
		return round( ( count( $order->get_items() ) + 1 ) * pow( 10, -$decimals ), $decimals );
	}

	/**
	 * What the customer still has to pay on a POS order left on hold, or on a web order still waiting
	 * for its transfer, cheque or cash on delivery.
	 */
	public static function owed( WC_Order $order ) {
		if ( ! self::awaiting_payment( $order ) ) {
			return 0.0;
		}
		$owed = self::balance( $order, self::payments( $order ) );
		return $owed > self::tolerance( $order ) ? $owed : 0.0;
	}

	private static function awaiting_payment( WC_Order $order ) {
		if ( Plugin::is_pos_order( $order ) ) {
			// Pending without a client_id is a sale that died while saving, which its retry replaces.
			return $order->has_status( 'on-hold' ) || ( $order->has_status( 'pending' ) && $order->get_meta( self::META_CLIENT_ID ) );
		}
		$gateway = $order->get_payment_method();
		// Cash on delivery goes to processing unpaid, and WooCommerce dates it paid on the way there.
		if ( 'cod' === $gateway ) {
			return $order->has_status( array( 'pending', 'on-hold', 'processing' ) );
		}
		return in_array( $gateway, self::PAID_LATER_GATEWAYS, true ) && $order->has_status( array( 'pending', 'on-hold' ) ) && ! $order->get_date_paid();
	}

	/**
	 * Moves an order along as it is packed, collected or shipped: a web order, or a paid till sale the
	 * customer takes later. Other till sales keep the status the till gave them, which says whether they are paid.
	 */
	public static function set_status( WC_Order $order, array $payload ) {
		$till    = Plugin::is_pos_order( $order );
		$allowed = $till ? array( 'processing', 'completed' ) : self::FULFIL_STATUSES;
		if ( 'shop_order' !== $order->get_type() || ! $order->has_status( $allowed ) || ( $till && ( ! $order->get_meta( self::META_FULFIL ) || ! $order->get_date_paid() ) ) ) {
			return new WP_Error( 'shoptill_status', __( 'Only orders being packed, collected or delivered can change status here.', 'shoptill' ), array( 'status' => 409 ) );
		}
		$status = sanitize_key( $payload['status'] ?? '' );
		if ( ! in_array( $status, $allowed, true ) ) {
			return new WP_Error( 'shoptill_status', __( 'Unknown order status.', 'shoptill' ), array( 'status' => 422 ) );
		}
		// On hold is how a bank transfer or cheque waits for its money, and moving it on would mark it paid.
		if ( 'on-hold' !== $status && $order->has_status( 'on-hold' ) && ! $order->get_date_paid() ) {
			return new WP_Error( 'shoptill_status', __( 'This order has not been paid yet. Take the payment here, or mark it paid in WooCommerce once the money arrives.', 'shoptill' ), array( 'status' => 409 ) );
		}
		if ( ! $order->update_status( $status, __( 'At the till.', 'shoptill' ), true ) ) {
			return new WP_Error( 'shoptill_status', __( 'The order status could not be changed.', 'shoptill' ), array( 'status' => 500 ) );
		}
		return $order;
	}

	/**
	 * A note on the order, for staff or for the customer, who is sent it when customer emails are on.
	 */
	public static function add_note( WC_Order $order, array $payload ) {
		$note = trim( sanitize_textarea_field( Plugin::text( $payload['note'] ?? '' ) ) );
		if ( '' === $note ) {
			return new WP_Error( 'shoptill_note', __( 'Write the note first.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$customer = ! empty( $payload['customer'] );
		if ( $customer && $order->get_billing_email() && Emails::to_customer( $order ) ) {
			$counted = Rest::count_mail( $order );
			if ( is_wp_error( $counted ) ) {
				return $counted;
			}
		}
		self::staff_note( $order, $note, $customer );
		// After the note, so a request that dies between the two leaves it twice rather than not at all.
		self::remember_request( $order, $payload );
		$order->save();
		return $order;
	}

	/**
	 * A note in the name of whoever is signed in to the till.
	 */
	private static function staff_note( WC_Order $order, $note, $customer = false ) {
		// WooCommerce only names the writer for staff who can edit the order, and a cashier may not.
		$by = static function ( $data ) {
			$data['comment_author']       = wp_get_current_user()->display_name;
			$data['comment_author_email'] = wp_get_current_user()->user_email;
			return $data;
		};
		add_filter( 'woocommerce_new_order_note_data', $by );
		try {
			$order->add_order_note( mb_substr( $note, 0, 1000 ), $customer ? 1 : 0 );
		} finally {
			remove_filter( 'woocommerce_new_order_note_data', $by );
		}
	}

	/**
	 * Take some or all of what is owed: on a POS order sold on account or synced underpaid, or on a web order.
	 */
	public static function take_payment( WC_Order $order, array $payload ) {
		$owed = self::owed( $order );
		if ( ! $owed ) {
			return new WP_Error( 'shoptill_not_owed', __( 'Nothing is owed on this order.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$tol = self::tolerance( $order );
		$new = self::sanitize_payments( isset( $payload['payments'] ) ? (array) $payload['payments'] : array() );
		if ( is_wp_error( $new ) ) {
			return $new;
		}
		$amount = array_sum( wp_list_pluck( $new, 'amount' ) );
		if ( ! $new || $amount > $owed + $tol ) {
			/* translators: %s: amount owed */
			return new WP_Error( 'shoptill_payment', sprintf( __( 'Take no more than the %s owed.', 'shoptill' ), wc_format_decimal( $owed, wc_get_price_decimals() ) ), array( 'status' => 422 ) );
		}

		$register = Settings::register( isset( $payload['register_id'] ) ? Plugin::text( $payload['register_id'] ) : '' );
		if ( ! $register ) {
			return new WP_Error( 'shoptill_register', __( 'Unknown register.', 'shoptill' ), array( 'status' => 422 ) );
		}
		// A later payment goes in the drawer it was taken at, on the day it was taken, so reports find it by both.
		foreach ( $new as &$row ) {
			$row['paid_at']     = time();
			$row['register_id'] = $register['id'];
		}
		unset( $row );
		$payments = array_merge( self::payments( $order ), $new );
		$order->add_meta_data( self::META_PAID_DAY, wp_date( 'Y-m-d' ) );
		self::set_payments( $order, $payments );
		self::remember_request( $order, $payload );
		$order->add_order_note(
			sprintf(
				/* translators: 1: amount, 2: cashier, 3: register */
				__( '%1$s paid at the till by %2$s on %3$s.', 'shoptill' ),
				wc_price( $amount ),
				wp_get_current_user()->display_name,
				$register['name']
			)
		);
		if ( self::balance( $order, $payments ) <= $tol ) {
			self::settle( $order, __( 'Paid in full.', 'shoptill' ) );
		} else {
			$order->save();
		}
		return wc_get_order( $order->get_id() );
	}

	/**
	 * Whether a refund or payment with this request_id has already been made on the order.
	 */
	public static function request_done( WC_Order $order, $request_id ) {
		if ( '' === $request_id ) {
			return false;
		}
		if ( in_array( $request_id, (array) $order->get_meta( self::META_REQUESTS ), true ) ) {
			return true;
		}
		foreach ( $order->get_refunds() as $refund ) {
			if ( $refund->get_meta( self::META_REQUEST ) === $request_id ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Keeps the request_id on the order, to be saved with the payment it made.
	 */
	private static function remember_request( WC_Order $order, array $payload ) {
		$request_id = isset( $payload['request_id'] ) ? sanitize_key( $payload['request_id'] ) : '';
		if ( '' !== $request_id ) {
			$seen = array_filter( (array) $order->get_meta( self::META_REQUESTS ) );
			$order->update_meta_data( self::META_REQUESTS, array_slice( array_merge( $seen, array( $request_id ) ), -20 ) );
		}
	}

	/**
	 * Marks the order paid in the same save as whatever else is pending on it, so a retry never finds
	 * its request done and the order still waiting for payment.
	 */
	private static function settle( WC_Order $order, $note ) {
		$order->set_date_paid( time() );
		// A web order goes on to be packed or collected, as it would once its gateway had been paid.
		$status = Plugin::is_pos_order( $order ) ? self::paid_status( $order ) : apply_filters( 'woocommerce_payment_complete_order_status', $order->needs_processing() ? 'processing' : 'completed', $order->get_id(), $order );
		$order->set_status( $status, $note );
		$order->save();
	}

	/**
	 * A paid till sale waits in processing while it is collected or delivered.
	 */
	private static function paid_status( WC_Order $order ) {
		return $order->get_meta( self::META_FULFIL ) ? 'processing' : Settings::order_status();
	}

	/**
	 * How a sale gets to a customer who doesn't take it away: null for one who does.
	 */
	private static function fulfilment( array $payload ) {
		$how = sanitize_key( Plugin::text( $payload['fulfil'] ?? '' ) );
		if ( '' === $how ) {
			return null;
		}
		if ( ! in_array( $how, array( 'collect', 'deliver' ), true ) ) {
			return new WP_Error( 'shoptill_fulfil', __( 'Choose collect or deliver.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$to = array();
		if ( 'deliver' === $how ) {
			$given = isset( $payload['ship_to'] ) && is_array( $payload['ship_to'] ) ? $payload['ship_to'] : array();
			$to    = Rest::address_input( $given );
			foreach ( array( 'first_name', 'last_name', 'phone' ) as $key ) {
				$to[ $key ] = sanitize_text_field( Plugin::text( $given[ $key ] ?? '' ) );
			}
			if ( '' === $to['address_1'] || '' === $to['city'] || ! isset( WC()->countries->get_shipping_countries()[ $to['country'] ] ) ) {
				return new WP_Error( 'shoptill_fulfil', __( 'A delivery needs a street, a town and a country the shop delivers to.', 'shoptill' ), array( 'status' => 422 ) );
			}
		}
		return array( $how, $to );
	}

	/**
	 * Marks paid an order waiting for its money that refunds have left owing nothing. Run again on a
	 * retried refund, in case the first died before it got this far. A paid sale put on hold stays there.
	 */
	public static function settle_if_cleared( WC_Order $order ) {
		if ( self::awaiting_payment( $order ) && ! $order->get_date_paid() && self::balance( $order, self::payments( $order ) ) <= self::tolerance( $order ) ) {
			self::settle( $order, __( 'Nothing left to pay.', 'shoptill' ) );
		}
	}

	private static function create_unlocked( $client_id, array $payload ) {
		if ( isset( $payload['tip'] ) && ( ! is_numeric( $payload['tip'] ) || ! is_finite( (float) $payload['tip'] ) || $payload['tip'] < 0 ) ) {
			return new WP_Error( 'shoptill_tip', __( 'The tip must be a number, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$sent_at    = isset( $payload['created_at'] ) ? (int) $payload['created_at'] : 0;
		$created_at = $sent_at && $sent_at <= time() && $sent_at > time() - 30 * DAY_IN_SECONDS ? $sent_at : 0;
		// The customer has already gone, so whatever changed in the shop since is noted rather than refused.
		$late     = $sent_at && $sent_at < time() - self::LATE_AFTER;
		$problems = array();
		if ( $late && ! $created_at ) {
			/* translators: %s: date the sale was made */
			$problems[] = sprintf( __( 'Made on %s, more than 30 days before it synced, so it is dated today.', 'shoptill' ), wp_date( get_option( 'date_format' ), $sent_at ) );
		}

		$register_id = isset( $payload['register_id'] ) ? Plugin::text( $payload['register_id'] ) : '';
		$register    = Settings::register( $register_id );
		if ( ! $register ) {
			if ( ! $late ) {
				return new WP_Error( 'shoptill_register', __( 'Unknown register.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$register   = array(
				'id'     => sanitize_key( $register_id ),
				'name'   => sanitize_text_field( $register_id ),
				'outlet' => '',
			);
			$problems[] = __( 'The register this sale was taken on has since been removed.', 'shoptill' );
		}

		$payments = self::sanitize_payments( isset( $payload['payments'] ) ? (array) $payload['payments'] : array(), $late );
		if ( is_wp_error( $payments ) ) {
			return $payments;
		}

		$items = self::build_items( isset( $payload['lines'] ) ? (array) $payload['lines'] : array(), $late, $problems );
		if ( is_wp_error( $items ) ) {
			return $items;
		}

		$fulfil = self::fulfilment( $payload );
		$given  = array_key_exists( 'delivery_charge', $payload ) ? $payload['delivery_charge'] : null;
		$charge = null !== $given ? round( self::number( $given ), wc_get_price_decimals() ) : 0.0;
		if ( null !== $given && ( ! is_numeric( $given ) || ! is_finite( (float) $given ) || $charge < 0 ) ) {
			return new WP_Error( 'shoptill_delivery_charge', __( 'The delivery charge must be an amount.', 'shoptill' ), array( 'status' => 422 ) );
		}
		if ( $charge && ( is_wp_error( $fulfil ) || 'deliver' !== $fulfil[0] ) ) {
			if ( ! $late ) {
				return new WP_Error( 'shoptill_delivery_charge', __( 'A delivery charge needs the sale marked for delivery.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$problems[] = sprintf(
				/* translators: %s: amount */
				__( 'The %s delivery charge was dropped, since the sale waits to be collected.', 'shoptill' ),
				wc_price( $charge )
			);
			$charge = 0.0;
		}
		if ( is_wp_error( $fulfil ) && ! $late ) {
			return $fulfil;
		} elseif ( is_wp_error( $fulfil ) ) {
			/* translators: %s: what was wrong with the delivery details */
			$problems[] = sprintf( __( '%s So it waits to be collected.', 'shoptill' ), $fulfil->get_error_message() );
			$fulfil     = array( 'collect', array() );
		}

		$order = new WC_Order();
		$order->set_created_via( Plugin::SOURCE );
		$order->set_prices_include_tax( wc_prices_include_tax() );
		$order->set_currency( get_woocommerce_currency() );
		self::set_customer( $order, isset( $payload['customer_id'] ) ? (int) $payload['customer_id'] : 0 );
		$order->update_meta_data( self::META_REGISTER, $register );
		$order->update_meta_data( self::META_CASHIER, self::cashier_id( $payload, $problems ) );
		// A note for staff only goes with the order's notes, off the receipt and the customer's emails.
		$staff_note = ! empty( $payload['note_private'] ) && ! empty( $payload['note'] ) ? sanitize_textarea_field( Plugin::text( $payload['note'] ) ) : '';
		if ( ! empty( $payload['note'] ) && ! $staff_note ) {
			$order->set_customer_note( sanitize_textarea_field( $payload['note'] ) );
		}
		if ( $created_at ) {
			$order->set_date_created( $created_at );
		}
		if ( $late ) {
			$order->update_meta_data( self::META_OFFLINE, 'yes' );
		}

		$order->update_meta_data( self::META_ATTEMPT, $client_id );
		foreach ( $items as $item ) {
			$order->add_item( $item );
		}
		// The charge screen adds the gratuity after tax, so it must stay tax-free here too.
		if ( ! empty( $payload['tip'] ) && is_numeric( $payload['tip'] ) && $payload['tip'] > 0 ) {
			$tip = new \WC_Order_Item_Fee();
			$tip->set_name( __( 'Tip', 'shoptill' ) );
			$tip->set_amount( (float) $payload['tip'] );
			$tip->set_total( (float) $payload['tip'] );
			$tip->set_tax_status( 'none' );
			$order->add_item( $tip );
		}

		if ( $charge ) {
			$shipping = new \WC_Order_Item_Shipping();
			$shipping->set_method_id( 'shoptill_delivery' );
			$shipping->set_method_title( __( 'Delivery', 'shoptill' ) );
			// In the shop's price terms, like a line's price; the tax is worked out below.
			$shipping->set_total( self::exclude_tax( $charge, '' ) );
			$order->add_item( $shipping );
		}
		// Line taxes must exist before coupons: with tax-inclusive prices WC_Discounts works off subtotal + subtotal tax.
		$order->calculate_totals( true );

		foreach ( self::coupon_codes( $payload ) as $code ) {
			$applied = $order->apply_coupon( $code );
			if ( ! is_wp_error( $applied ) ) {
				continue;
			}
			if ( ! $late ) {
				self::discard( $order );
				return new WP_Error( 'shoptill_coupon', wp_strip_all_tags( $applied->get_error_message() ), array( 'status' => 422, 'code' => $code ) );
			}
			/* translators: 1: coupon code, 2: reason */
			$problems[] = sprintf( __( 'Coupon %1$s was not applied: %2$s', 'shoptill' ), $code, wp_strip_all_tags( $applied->get_error_message() ) );
		}

		self::apply_line_discounts( $order, $items, (array) $payload['lines'] );
		$order->calculate_totals( true );
		self::keep_shelf_prices( $order );
		self::keep_delivery_price( $order, $charge );

		$decimals  = wc_get_price_decimals();
		$due       = (float) $order->get_total();
		$shortfall = self::balance( $order, $payments );
		$tolerance = self::tolerance( $order );
		$pay_later = ! empty( $payload['pay_later'] ) && $order->get_customer_id() && Settings::flag( 'pay_later' );
		$on_hold   = false;
		// Coupons priced offline, or while the shop couldn't be asked, can come to something else by now. The
		// customer paid what the till showed, so the difference is noted rather than the sale refused.
		$drifted = self::coupon_codes( $payload ) && isset( $payload['expected_total'] ) && abs( self::number( $payload['expected_total'] ) - ( $due - $shortfall ) ) <= $tolerance;
		$lenient = $late || $drifted;
		if ( $shortfall > $tolerance && $pay_later ) {
			$on_hold = true;
			/* translators: %s: amount */
			$problems[] = sprintf( __( 'Sold on account: %s to pay later.', 'shoptill' ), wc_price( $shortfall ) );
		} elseif ( $shortfall > $tolerance ) {
			if ( ! $lenient ) {
				self::discard( $order );
				return new WP_Error(
					'shoptill_underpaid',
					sprintf( __( 'Payments (%1$s) do not cover the order total (%2$s).', 'shoptill' ), wc_format_decimal( $due - $shortfall, $decimals ), wc_format_decimal( $due, $decimals ) ),
					array(
						'status' => 422,
						'total'  => $due,
					)
				);
			}
			$on_hold = true;
			/* translators: %s: amount */
			$problems[] = sprintf( __( 'Payments fall %s short of the total, so the order is on hold.', 'shoptill' ), wc_price( $shortfall ) );
		} elseif ( -$shortfall > $tolerance ) {
			if ( ! $lenient ) {
				self::discard( $order );
				/* translators: 1: payments, 2: order total */
				return new WP_Error( 'shoptill_overpaid', sprintf( __( 'Payments (%1$s) come to more than the order total (%2$s).', 'shoptill' ), wc_format_decimal( $due - $shortfall, $decimals ), wc_format_decimal( $due, $decimals ) ), array( 'status' => 422 ) );
			}
			/* translators: %s: amount */
			$problems[] = sprintf( __( 'Payments add up to %s more than the total.', 'shoptill' ), wc_price( -$shortfall ) );
		}

		if ( isset( $payload['expected_total'] ) && abs( self::number( $payload['expected_total'] ) - $due ) >= 0.005 ) {
			$problems[] = sprintf(
				/* translators: 1: total shown on the till, 2: total WooCommerce calculated */
				__( 'The till showed a total of %1$s; WooCommerce calculated %2$s.', 'shoptill' ),
				wc_price( self::number( $payload['expected_total'] ) ),
				wc_price( $due )
			);
		}
		foreach ( $problems as $problem ) {
			$order->add_order_note( $problem );
		}
		if ( '' !== $staff_note ) {
			self::staff_note( $order, $staff_note );
		}
		if ( $fulfil ) {
			$order->update_meta_data( self::META_FULFIL, $fulfil[0] );
			foreach ( $fulfil[1] as $key => $value ) {
				$order->{"set_shipping_$key"}( $value );
			}
		}

		self::set_payments( $order, $payments );
		if ( ! $on_hold ) {
			$order->set_date_paid( $created_at ? $created_at : time() );
		}
		// Saved with the status. The two order stores write them in opposite orders, which create() allows for.
		$order->update_meta_data( self::META_CLIENT_ID, $client_id );
		$order->set_status(
			$on_hold ? 'on-hold' : self::paid_status( $order ),
			/* translators: %s: register name */
			sprintf( __( 'POS sale on %s.', 'shoptill' ), $register['name'] )
		);
		$order->save();
		// The cost plugin's own stamping never sees a till order, which is created straight at its final status.
		Costs::stamp_items( $order );

		return wc_get_order( $order->get_id() );
	}

	/**
	 * Delete an order the till's sale was refused as, handing back the coupon uses apply_coupon() counted.
	 */
	private static function discard( WC_Order $order ) {
		foreach ( $order->get_coupon_codes() as $code ) {
			$order->remove_coupon( $code );
		}
		$order->delete( true );
	}

	/**
	 * WooCommerce recalculates order tax from prices without tax, which can leave a tax-inclusive line a
	 * cent off its shelf price. Each line is split again from its price with tax, the way the cart does it.
	 */
	private static function keep_shelf_prices( WC_Order $order ) {
		if ( ! wc_tax_enabled() || ! $order->get_prices_include_tax() ) {
			return;
		}
		$decimals = wc_get_price_decimals();
		$per_line = 'yes' !== get_option( 'woocommerce_tax_round_at_subtotal' );
		foreach ( $order->get_items() as $item ) {
			if ( 'taxable' !== $item->get_tax_status() ) {
				continue;
			}
			$rates = WC_Tax::get_base_tax_rates( $item->get_tax_class() );
			$taxes = $item->get_taxes();
			$split = array();
			foreach ( array( 'subtotal', 'total' ) as $key ) {
				$gross         = round( (float) ( 'total' === $key ? $item->get_total() : $item->get_subtotal() ) + array_sum( $taxes[ $key ] ), $decimals );
				$tax           = WC_Tax::calc_tax( $gross, $rates, true );
				$tax           = $per_line ? array_map( 'wc_round_tax_total', $tax ) : $tax;
				$split[ $key ] = array( $gross - array_sum( $tax ), $tax );
			}
			$item->set_subtotal( $split['subtotal'][0] );
			$item->set_total( $split['total'][0] );
			$item->set_taxes(
				array(
					'subtotal' => $split['subtotal'][1],
					'total'    => $split['total'][1],
				)
			);
			$item->save();
		}
		$order->update_taxes();
		$order->calculate_totals( false );
	}

	/**
	 * WooCommerce recalculates a shipping line's tax with the shop's shipping tax class, which is not
	 * necessarily the rate the till charged. A delivery charge is taxed like everything else at the
	 * till: at the base rate for the standard class, from the price the shop's terms gave.
	 */
	private static function keep_delivery_price( WC_Order $order, $charge ) {
		if ( ! $charge ) {
			return;
		}
		foreach ( $order->get_items( 'shipping' ) as $item ) {
			if ( 'shoptill_delivery' !== $item->get_method_id() ) {
				continue;
			}
			if ( wc_tax_enabled() ) {
				$decimals = wc_get_price_decimals();
				$per_line = 'yes' !== get_option( 'woocommerce_tax_round_at_subtotal' );
				$rates    = WC_Tax::get_base_tax_rates( '' );
				$tax      = WC_Tax::calc_tax( $charge, $rates, $order->get_prices_include_tax() );
				if ( $per_line ) {
					$tax = array_map( 'wc_round_tax_total', $tax );
				}
				$item->set_taxes(
					array(
						'total'    => $tax,
						'subtotal' => $tax,
					)
				);
				// With tax in the price, the charge is gross; without, it is what is charged.
				$item->set_total( $order->get_prices_include_tax() ? round( $charge - array_sum( $tax ), $decimals ) : $charge );
			} else {
				$item->set_total( $charge );
			}
			$item->save();
			break;
		}
		$order->update_taxes();
		$order->calculate_totals( false );
	}

	/**
	 * A sale queued offline syncs under whoever is signed in by then, so the till says who rang it up.
	 */
	private static function cashier_id( array $payload, array &$problems ) {
		$current = get_current_user_id();
		$claimed = isset( $payload['cashier_id'] ) ? (int) $payload['cashier_id'] : 0;
		if ( ! $claimed || $claimed === $current ) {
			return $current;
		}
		$user = get_userdata( $claimed );
		if ( ! $user || ! user_can( $user, Plugin::CAP_USE ) ) {
			return $current;
		}
		/* translators: 1: cashier who took the sale, 2: user signed in when it synced */
		$problems[] = sprintf( __( 'Taken by %1$s, synced while %2$s was signed in.', 'shoptill' ), $user->display_name, wp_get_current_user()->display_name );
		return $claimed;
	}

	/**
	 * @return WC_Order_Item_Product[]|WP_Error
	 */
	private static function build_items( array $lines, $late = false, array &$problems = array() ) {
		if ( ! $lines ) {
			return new WP_Error( 'shoptill_empty', __( 'The cart is empty.', 'shoptill' ), array( 'status' => 422 ) );
		}
		if ( $lines !== array_values( $lines ) ) {
			return new WP_Error( 'shoptill_line', __( 'Items must be sent as a list.', 'shoptill' ), array( 'status' => 422 ) );
		}
		foreach ( $lines as $line ) {
			if ( ! is_array( $line ) ) {
				return new WP_Error( 'shoptill_line', __( 'Every line must be an item.', 'shoptill' ), array( 'status' => 422 ) );
			}
			foreach ( array( 'qty', 'price', 'discount', 'cost' ) as $key ) {
				if ( ! array_key_exists( $key, $line ) || ( 'cost' === $key && '' === $line[ $key ] ) ) {
					continue;
				}
				if ( ! is_numeric( $line[ $key ] ) || ! is_finite( (float) $line[ $key ] ) || $line[ $key ] < 0 ) {
					return new WP_Error( 'shoptill_' . $key, __( 'Item quantities and amounts must be finite numbers, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
				}
			}
		}

		$tax_classes = array_merge( array( '' ), WC_Tax::get_tax_class_slugs() );
		$items       = array();
		$stock_use   = array();
		// Product id => [ name, units ] for products sold individually, across all lines of the sale.
		$solo        = array();

		// Manual price changes are staff work unless the shop lets others make them.
		$may_price = current_user_can( 'edit_products' ) || Settings::flag( 'cashier_prices' );
		if ( ! $may_price ) {
			foreach ( $lines as $priced ) {
				if ( isset( $priced['discount'] ) && self::number( $priced['discount'] ) > 0 ) {
					if ( ! $late ) {
						return new WP_Error( 'shoptill_price', __( 'Only staff may change prices or give discounts.', 'shoptill' ), array( 'status' => 422 ) );
					}
					$problems[] = __( 'A discount was given by an account that may not change prices; the sale is kept as charged.', 'shoptill' );
					break;
				}
			}
		}
		foreach ( $lines as $line ) {
			$qty = wc_stock_amount( self::number( $line['qty'] ?? 0 ) );
			if ( $qty <= 0 ) {
				return new WP_Error( 'shoptill_qty', __( 'Every line needs a quantity above zero.', 'shoptill' ), array( 'status' => 422 ) );
			}

			$item    = new WC_Order_Item_Product();
			$untaxed = false;
			$item->set_quantity( $qty );
			// A cost the till froze when the sale was made, which only a staff catalogue ever carried.
			// Freezing one is the same privilege as seeing one, so a cashier's till cannot move margins.
			if ( Costs::active() && Costs::may_see() && array_key_exists( 'cost', $line ) ) {
				if ( '' !== $line['cost'] && ( ! is_numeric( $line['cost'] ) || $line['cost'] < 0 ) ) {
					return new WP_Error( 'shoptill_cost', __( 'The cost must be a number, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
				}
				if ( '' !== $line['cost'] ) {
					Costs::freeze( $item, $line['cost'] );
				}
			}

			$product = empty( $line['product_id'] ) ? null : wc_get_product( (int) $line['product_id'] );
			$gone    = ! $product || $product->is_type( 'variable' );
			if ( ! empty( $line['product_id'] ) && ( $gone || ! Catalog::is_sellable( $product ) ) ) {
				if ( ! $late ) {
					return new WP_Error( 'shoptill_product', sprintf( __( 'Product %d is not available.', 'shoptill' ), (int) $line['product_id'] ), array( 'status' => 422 ) );
				}
				if ( $gone ) {
					// Sold before it was deleted: keep the line and its money as a custom item.
					$product = null;
					$line   += array( 'name' => sprintf( __( 'Product #%d', 'shoptill' ), (int) $line['product_id'] ) );
					$untaxed = isset( $line['taxable'] ) && ! rest_sanitize_boolean( $line['taxable'] );
					/* translators: %s: product name */
					$problems[] = sprintf( __( '%s no longer exists, so it was recorded as a custom item.', 'shoptill' ), sanitize_text_field( $line['name'] ) );
				} else {
					/* translators: %s: product name */
					$problems[] = sprintf( __( '%s was taken off sale before this sale synced.', 'shoptill' ), $product->get_name() );
				}
			}

			if ( $product ) {
				if ( $product->managing_stock() || ! $product->is_in_stock() ) {
					$owner                   = $product->managing_stock() ? $product->get_stock_managed_by_id() : $product->get_id();
					$stock_use[ $owner ]     = isset( $stock_use[ $owner ] ) ? $stock_use[ $owner ] : array( $product, 0 );
					$stock_use[ $owner ][1] += $qty;
				}
				if ( $product->is_sold_individually() ) {
					$solo[ $product->get_id() ] = array( $product->get_name(), $qty + ( isset( $solo[ $product->get_id() ] ) ? $solo[ $product->get_id() ][1] : 0 ) );
				}

				$unit     = isset( $line['price'] ) ? max( 0, self::number( $line['price'] ) ) : (float) $product->get_price();
				$subtotal = wc_get_price_excluding_tax(
					$product,
					array(
						'qty'   => $qty,
						'price' => $unit,
					)
				);
				$item->set_product( $product );
				if ( isset( $line['price'] ) && self::number( $line['price'] ) !== (float) $product->get_price() ) {
					// price_changed is set by the till only when the price was deliberately changed, so a stale
					// catalogue (the customer paid what the shelf said) is not mistaken for an override.
					if ( ! empty( $line['price_changed'] ) && ! $may_price ) {
						if ( ! $late ) {
							return new WP_Error( 'shoptill_price', __( 'Only staff may change item prices.', 'shoptill' ), array( 'status' => 422 ) );
						}
						$problems[] = sprintf( __( '%s was sold at a changed price by an account that may not change prices; the sale is kept as charged.', 'shoptill' ), $product->get_name() );
					}
					$item->add_meta_data( '_shoptill_price_override', wc_format_decimal( $unit ), true );
				}
			} else {
				$name      = isset( $line['name'] ) ? sanitize_text_field( $line['name'] ) : '';
				$tax_class = isset( $line['tax_class'] ) ? sanitize_title( Plugin::text( $line['tax_class'] ) ) : '';
				if ( $late && '' !== $name && ! in_array( $tax_class, $tax_classes, true ) ) {
					if ( ! $untaxed ) {
						/* translators: %s: item name */
						$problems[] = sprintf( __( 'The tax class on %s has since been removed, so it was taxed at the standard rate.', 'shoptill' ), $name );
					}
					$tax_class = '';
				}
				if ( '' === $name || ! in_array( $tax_class, $tax_classes, true ) ) {
					return new WP_Error( 'shoptill_custom_item', __( 'Custom items need a name and a valid tax class.', 'shoptill' ), array( 'status' => 422 ) );
				}
				$unit     = isset( $line['price'] ) ? max( 0, self::number( $line['price'] ) ) : 0;
				$subtotal = $untaxed ? $unit * $qty : self::exclude_tax( $unit * $qty, $tax_class );
				$item->set_name( $name );
				// With no product behind it the line counts as taxable, and tax class '0' is how WooCommerce skips one.
				$item->set_tax_class( $untaxed ? '0' : $tax_class );
			}

			$item->set_subtotal( $subtotal );
			$item->set_total( $subtotal );
			$items[] = $item;
		}

		// Checked per stock holder, so two lines of one product or variations sharing parent stock add up.
		foreach ( $stock_use as $use ) {
			list( $product, $qty ) = $use;
			// Stock held for online checkouts still being paid for is spoken for.
			if ( Settings::flag( 'allow_oversell', 'yes' ) || $product->backorders_allowed() || ( $product->managing_stock() && $product->get_stock_quantity() - wc_get_held_stock_quantity( $product ) >= $qty ) ) {
				continue;
			}
			if ( ! $late ) {
				return new WP_Error( 'shoptill_stock', sprintf( __( 'Not enough stock for %s.', 'shoptill' ), $product->get_name() ), array( 'status' => 422 ) );
			}
			/* translators: %s: product name */
			$problems[] = sprintf( __( 'Sold offline with more %s than was in stock.', 'shoptill' ), $product->get_name() );
		}

		// A client other than the till could put two of one on an order; the till itself already refuses.
		foreach ( $solo as $use ) {
			if ( $use[1] < 2 ) {
				continue;
			}
			if ( ! $late ) {
				return new WP_Error( 'shoptill_individual', sprintf( __( '%s is sold one at a time.', 'shoptill' ), $use[0] ), array( 'status' => 422 ) );
			}
			/* translators: %s: product name */
			$problems[] = sprintf( __( '%s is sold one at a time, so this sale has more than one of it.', 'shoptill' ), $use[0] );
		}

		return $items;
	}

	/**
	 * Manual discounts go on after coupons, the same order the till applies them in.
	 */
	private static function apply_line_discounts( WC_Order $order, array $items, array $lines ) {
		foreach ( $items as $index => $item ) {
			$discount = isset( $lines[ $index ]['discount'] ) ? max( 0, self::number( $lines[ $index ]['discount'] ) ) : 0;
			if ( ! $discount ) {
				continue;
			}
			if ( 'taxable' === $item->get_tax_status() ) {
				$discount = self::exclude_tax( $discount, $item->get_tax_class() );
			}
			$item->set_total( max( 0, (float) $item->get_total() - $discount ) );
			$item->add_meta_data( '_shoptill_discount', wc_format_decimal( $lines[ $index ]['discount'] ), true );
			$item->add_meta_data( '_shoptill_discount_ex_tax', wc_format_decimal( $discount, WC_ROUNDING_PRECISION ), true );
			$item->save();
		}
	}

	/**
	 * Strip tax from an amount entered in the shop's price terms. Unrounded, like wc_get_price_excluding_tax().
	 */
	private static function exclude_tax( $amount, $tax_class ) {
		if ( ! wc_tax_enabled() || ! wc_prices_include_tax() ) {
			return $amount;
		}
		return $amount - array_sum( WC_Tax::calc_tax( $amount, WC_Tax::get_base_tax_rates( $tax_class ), true ) );
	}

	private static function set_customer( WC_Order $order, $customer_id ) {
		if ( ! $customer_id ) {
			return;
		}
		$customer = new \WC_Customer( $customer_id );
		if ( ! $customer->get_id() || ! Rest::is_customer( $customer->get_id() ) ) {
			return;
		}
		// Contact details only. Address fields would move the tax location away from the shop.
		$order->set_customer_id( $customer->get_id() );
		$order->set_billing_first_name( $customer->get_billing_first_name() ? $customer->get_billing_first_name() : $customer->get_first_name() );
		$order->set_billing_last_name( $customer->get_billing_last_name() ? $customer->get_billing_last_name() : $customer->get_last_name() );
		$order->set_billing_email( $customer->get_billing_email() ? $customer->get_billing_email() : $customer->get_email() );
		$order->set_billing_phone( $customer->get_billing_phone() );
	}

	private static function coupon_codes( array $payload ) {
		$codes = isset( $payload['coupons'] ) ? array_filter( (array) $payload['coupons'], 'is_string' ) : array();
		return array_values( array_unique( array_filter( array_map( 'wc_format_coupon_code', $codes ) ) ) );
	}

	/**
	 * A number from the request, and 0 for anything else: PHP casts an array to 1.
	 */
	private static function number( $value ) {
		return is_numeric( $value ) && is_finite( (float) $value ) ? (float) $value : 0.0;
	}

	private static function sanitize_payments( array $payments, $late = false ) {
		// A method switched off after an offline sale was taken still has to be recorded.
		$methods = $late ? Settings::payment_methods() + Settings::method_labels() : Settings::payment_methods();
		$clean   = array();
		foreach ( $payments as $payment ) {
			if ( ! is_array( $payment ) || ! isset( $payment['amount'] ) || ! is_numeric( $payment['amount'] ) || ! is_finite( (float) $payment['amount'] ) ) {
				return new WP_Error( 'shoptill_payment', __( 'Every payment needs a finite amount.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$method = isset( $payment['method'] ) ? sanitize_key( $payment['method'] ) : '';
			$amount = (float) wc_format_decimal( self::number( $payment['amount'] ?? 0 ), wc_get_price_decimals() );
			if ( ! isset( $methods[ $method ] ) || $amount <= 0 ) {
				return new WP_Error( 'shoptill_payment', __( 'Unknown payment method or empty amount.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$row = array(
				'method' => $method,
				'label'  => $methods[ $method ],
				'amount' => $amount,
			);
			if ( 'cash' === $method && isset( $payment['tendered'] ) ) {
				$row['tendered'] = (float) wc_format_decimal( max( $amount, self::number( $payment['tendered'] ) ), wc_get_price_decimals() );
				$row['change']   = (float) wc_format_decimal( $row['tendered'] - $amount, wc_get_price_decimals() );
			}
			if ( ! empty( $payment['reference'] ) ) {
				$row['reference'] = sanitize_text_field( $payment['reference'] );
			}
			$clean[] = $row;
		}
		// An empty list is fine here: the underpayment check refuses it unless nothing is due.
		return $clean;
	}

	private static function set_payments( WC_Order $order, array $payments ) {
		$order->update_meta_data( self::META_PAYMENTS, $payments );
		// A web order keeps the checkout method it was placed with.
		if ( ! Plugin::is_pos_order( $order ) ) {
			return;
		}
		if ( ! $payments ) {
			$order->set_payment_method( 'shoptill_none' );
			$order->set_payment_method_title( (float) $order->get_total() > 0 ? __( 'On account', 'shoptill' ) : __( 'Nothing to pay', 'shoptill' ) );
			return;
		}
		if ( 1 === count( $payments ) ) {
			$order->set_payment_method( 'shoptill_' . $payments[0]['method'] );
			$order->set_payment_method_title( $payments[0]['label'] );
			if ( ! empty( $payments[0]['reference'] ) ) {
				$order->set_transaction_id( $payments[0]['reference'] );
			}
			return;
		}
		$order->set_payment_method( 'shoptill_split' );
		$order->set_payment_method_title(
			sprintf(
				/* translators: %s: list of payment methods and amounts */
				__( 'Split: %s', 'shoptill' ),
				implode(
					', ',
					array_map(
						static function ( $p ) {
							return $p['label'] . ' ' . wc_format_decimal( $p['amount'], wc_get_price_decimals() );
						},
						$payments
					)
				)
			)
		);
	}

	private static function find_by_client_id( $client_id, $key = self::META_CLIENT_ID, $status = 'any' ) {
		// meta_key/meta_value rather than meta_query: the legacy posts store silently drops meta_query.
		$orders = wc_get_orders(
			array(
				'limit'      => 1,
				'type'       => 'shop_order',
				'status'     => $status,
				'meta_key'   => $key, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value' => $client_id, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			)
		);
		return $orders ? $orders[0] : null;
	}

	public static function base_location() {
		return array(
			'country'  => WC()->countries->get_base_country(),
			'state'    => WC()->countries->get_base_state(),
			'postcode' => WC()->countries->get_base_postcode(),
			'city'     => WC()->countries->get_base_city(),
		);
	}

	/**
	 * Refund whole lines by quantity, or a plain amount when no lines are given.
	 *
	 * @param WC_Order $order   The order.
	 * @param array    $payload { lines: [{item_id, qty}], amount?, restock, reason, method }.
	 */
	public static function refund( WC_Order $order, array $payload ) {
		$decimals   = wc_get_price_decimals();
		$line_items = array();
		$amount     = 0;

		$wanted = array();
		foreach ( isset( $payload['lines'] ) ? (array) $payload['lines'] : array() as $line ) {
			$item_id            = (int) ( $line['item_id'] ?? 0 );
			$wanted[ $item_id ] = ( $wanted[ $item_id ] ?? 0 ) + wc_stock_amount( self::number( $line['qty'] ?? 0 ) );
		}

		foreach ( $wanted as $item_id => $qty ) {
			// get_item() loads any order's item by ID, so ownership is checked here.
			$item = $order->get_item( $item_id );
			if ( ! $item instanceof WC_Order_Item_Product || $item->get_order_id() !== $order->get_id() || $qty <= 0 ) {
				return new WP_Error( 'shoptill_refund_line', __( 'Invalid refund line.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$refundable = $item->get_quantity() + $order->get_qty_refunded_for_item( $item->get_id() );
			if ( $qty > $refundable ) {
				return new WP_Error( 'shoptill_refund_qty', sprintf( __( 'Only %1$s of %2$s can still be refunded.', 'shoptill' ), $refundable, $item->get_name() ), array( 'status' => 422 ) );
			}

			// The last units back take whatever is left of the line, so unit refunds add up to the order.
			$last       = $qty >= $refundable;
			$share      = $qty / $item->get_quantity();
			$line_total = $last ? (float) $item->get_total() - $order->get_total_refunded_for_item( $item_id ) : (float) $item->get_total() * $share;
			$line_total = round( $line_total, $decimals );
			$line_taxes = array();
			$taxes      = $item->get_taxes();
			foreach ( $taxes['total'] as $rate_id => $tax ) {
				$tax                    = $last ? (float) $tax - $order->get_tax_refunded_for_item( $item_id, $rate_id ) : (float) $tax * $share;
				$line_taxes[ $rate_id ] = round( $tax, $decimals );
			}

			$line_items[ $item->get_id() ] = array(
				'qty'          => $qty,
				'refund_total' => $line_total,
				'refund_tax'   => $line_taxes,
			);
			$amount                       += $line_total + array_sum( $line_taxes );
		}

		if ( ! $line_items ) {
			$amount = self::number( $payload['amount'] ?? 0 );
		} else {
			// Money already refunded by amount may have covered these items, and they still come back.
			// The lines are scaled to what goes back, so the refunded tax and per-item totals match it.
			$full   = $amount;
			$amount = min( $amount, (float) $order->get_remaining_refund_amount() );
			if ( $full > 0 && $amount < $full ) {
				foreach ( $line_items as &$refund_line ) {
					$refund_line['refund_total'] = round( $refund_line['refund_total'] * $amount / $full, $decimals );
					$refund_line['refund_tax']   = array_map(
						static function ( $tax ) use ( $amount, $full, $decimals ) {
							return round( $tax * $amount / $full, $decimals );
						},
						$refund_line['refund_tax']
					);
				}
				unset( $refund_line );
			}
		}
		$amount = round( $amount, $decimals );
		// Zero is fine when items come back: a free item still goes back in stock.
		if ( $amount < 0 || ( ! $line_items && ! $amount ) || $amount > (float) $order->get_remaining_refund_amount() + 0.001 ) {
			return new WP_Error( 'shoptill_refund_amount', __( 'Refund amount is zero or more than is left to refund.', 'shoptill' ), array( 'status' => 422 ) );
		}

		// Goods returned before they were paid for come off the debt first; only the rest is money back.
		$owed      = self::owed( $order );
		$off_owed  = min( $amount, $owed );
		$paid_back = round( $amount - $off_owed, $decimals );
		$methods   = Settings::payment_methods();
		$method    = isset( $payload['method'] ) ? sanitize_key( $payload['method'] ) : '';
		if ( $paid_back > 0 && ! isset( $methods[ $method ] ) ) {
			return new WP_Error( 'shoptill_refund_method', __( 'Choose how the money goes back.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$register = Settings::register( isset( $payload['register_id'] ) ? Plugin::text( $payload['register_id'] ) : '' );
		if ( ! $register ) {
			return new WP_Error( 'shoptill_register', __( 'Unknown register.', 'shoptill' ), array( 'status' => 422 ) );
		}
		// Saved with the refund's first save, which WooCommerce makes well before its refund hooks, so a
		// request that dies after it happens once and reports where it was made, and one that dies
		// before it happens on the retry.
		$meta     = array_filter(
			array(
				self::META_REQUEST   => isset( $payload['request_id'] ) ? sanitize_key( $payload['request_id'] ) : '',
				self::META_OFF_OWED  => $off_owed > 0 ? $off_owed : null,
				self::META_REFUND_BY => $paid_back > 0 ? $method : null,
				self::META_REGISTER  => $register,
				self::META_CASHIER   => get_current_user_id(),
			)
		);
		$order_id = $order->get_id();
		$tag      = static function ( $refund ) use ( $meta, $order_id ) {
			if ( ! $refund->get_id() && $refund->get_parent_id() === $order_id ) {
				foreach ( $meta as $key => $value ) {
					$refund->update_meta_data( $key, $value );
				}
			}
		};
		add_action( 'woocommerce_before_order_refund_object_save', $tag );
		try {
			$refund = wc_create_refund(
				array(
					'order_id'       => $order->get_id(),
					'amount'         => $amount,
					'reason'         => isset( $payload['reason'] ) ? sanitize_text_field( $payload['reason'] ) : '',
					'line_items'     => $line_items,
					'refund_payment' => false,
					'restock_items'  => ! empty( $payload['restock'] ),
				)
			);
		} finally {
			remove_action( 'woocommerce_before_order_refund_object_save', $tag );
		}
		if ( is_wp_error( $refund ) ) {
			return $refund;
		}

		if ( $off_owed > 0 ) {
			/* translators: %s: amount */
			$order->add_order_note( sprintf( __( '%s of the refund came off what the customer owed.', 'shoptill' ), wc_price( $off_owed ) ) );
		}
		if ( $paid_back > 0 ) {
			/* translators: 1: amount, 2: payment method */
			$order->add_order_note( sprintf( __( 'Refunded %1$s at the till by %2$s.', 'shoptill' ), wc_price( $paid_back ), $methods[ $method ] ) );
		}

		self::settle_if_cleared( wc_get_order( $order->get_id() ) );
		return $refund;
	}
}
