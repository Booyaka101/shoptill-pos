<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

final class Plugin {

	const CAP_USE    = 'shoptill_use_pos';
	const CAP_REFUND = 'shoptill_refund';
	const SOURCE     = 'shoptill';

	public static function init() {
		Settings::init();
		Rest::init();
		App::init();
		Admin::init();
		Emails::init();

		// Granted per request rather than written to the role, so turning the setting off takes it back.
		add_filter(
			'user_has_cap',
			static function ( $caps ) {
				// A refund cap taken away from one user on purpose stays taken away.
				if ( ! empty( $caps[ self::CAP_USE ] ) && ! isset( $caps[ self::CAP_REFUND ] ) && Settings::flag( 'cashier_refunds' ) ) {
					$caps[ self::CAP_REFUND ] = true;
				}
				return $caps;
			}
		);

		add_filter( 'woocommerce_coupon_is_valid', array( Orders::class, 'check_coupon' ), 10, 3 );
		add_filter(
			'woocommerce_order_class',
			static function ( $classname ) {
				// Do not replace another extension's custom order or refund class.
				if ( 'WC_Order' === $classname ) {
					return Discount_Order::class;
				}
				if ( '\\Automattic\\WooCommerce\\Admin\\Overrides\\Order' === $classname ) {
					return Admin_Discount_Order::class;
				}
				return $classname;
			},
			20
		);

		// In-person sales are taxed where the shop is, whatever address the customer has on file.
		add_filter(
			'woocommerce_order_get_tax_location',
			static function ( $location, $order ) {
				return self::is_pos_order( $order ) ? Orders::base_location() : $location;
			},
			10,
			2
		);
	}

	/**
	 * Text from a request, and '' for anything else: PHP casts an array to "Array".
	 */
	public static function text( $value ) {
		return is_scalar( $value ) ? (string) $value : '';
	}

	public static function is_pos_order( $order ) {
		return $order instanceof \WC_Abstract_Order && self::SOURCE === $order->get_created_via();
	}

	public static function activate() {
		add_role(
			'shoptill_cashier',
			__( 'POS Cashier', 'shoptill' ),
			array(
				'read'         => true,
				self::CAP_USE  => true,
			)
		);
		foreach ( array( 'administrator', 'shop_manager' ) as $role_name ) {
			$role = get_role( $role_name );
			if ( $role ) {
				$role->add_cap( self::CAP_USE );
				$role->add_cap( self::CAP_REFUND );
			}
		}
		App::add_rewrite_rules();
		flush_rewrite_rules();
	}

	public static function deactivate() {
		// flush_rewrite_rules() would rebuild from the rules still registered this request, /pos included.
		delete_option( 'rewrite_rules' );
		Auth::revoke_all();
	}
}
