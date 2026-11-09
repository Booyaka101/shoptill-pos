<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

/**
 * Keeps WooCommerce's automatic emails off POS sales unless the shop asks for them.
 */
final class Emails {

	const CUSTOMER_EMAILS = array(
		'customer_processing_order',
		'customer_completed_order',
		'customer_on_hold_order',
		'customer_failed_order',
		'customer_cancelled_order',
		'customer_refunded_order',
		'customer_partially_refunded_order',
		'customer_invoice',
		'customer_note',
	);

	private static $sending_receipt = false;

	public static function init() {
		foreach ( self::CUSTOMER_EMAILS as $id ) {
			add_filter( 'woocommerce_email_enabled_' . $id, array( __CLASS__, 'filter_customer' ), 10, 2 );
		}
		add_filter( 'woocommerce_email_enabled_new_order', array( __CLASS__, 'filter_admin' ), 10, 2 );
	}

	/**
	 * Set while the till is emailing a receipt on request, which always goes out.
	 */
	public static function sending_receipt( $sending ) {
		self::$sending_receipt = (bool) $sending;
	}

	public static function filter_customer( $enabled, $order ) {
		return $enabled && ( self::$sending_receipt || self::to_customer( $order ) );
	}

	/**
	 * Whether WooCommerce's own customer emails go out for an order.
	 */
	public static function to_customer( $order ) {
		return ! Plugin::is_pos_order( $order ) || Settings::flag( 'email_customer' );
	}

	public static function filter_admin( $enabled, $order ) {
		if ( ! Plugin::is_pos_order( $order ) ) {
			return $enabled;
		}
		return $enabled && Settings::flag( 'email_admin' );
	}
}
