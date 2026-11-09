<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

/**
 * POS details in the order screens.
 */
final class Admin {

	public static function init() {
		add_filter( 'manage_woocommerce_page_wc-orders_columns', array( __CLASS__, 'add_column' ) );
		add_action( 'manage_woocommerce_page_wc-orders_custom_column', array( __CLASS__, 'render_column' ), 10, 2 );
		add_filter( 'manage_edit-shop_order_columns', array( __CLASS__, 'add_column' ) );
		add_action( 'manage_shop_order_posts_custom_column', array( __CLASS__, 'render_column' ), 10, 2 );
		add_action( 'woocommerce_admin_order_data_after_billing_address', array( __CLASS__, 'order_details' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 80 );
		add_action( 'woocommerce_product_options_general_product_data', array( __CLASS__, 'product_field' ) );
		add_action( 'woocommerce_admin_process_product_object', array( __CLASS__, 'save_product_field' ) );
	}

	public static function add_column( $columns ) {
		$columns['shoptill'] = __( 'Register', 'shoptill' );
		return $columns;
	}

	public static function render_column( $column, $order ) {
		if ( 'shoptill' !== $column ) {
			return;
		}
		$order    = $order instanceof \WC_Order ? $order : wc_get_order( $order );
		$register = $order ? $order->get_meta( Orders::META_REGISTER ) : null;
		echo is_array( $register ) ? esc_html( $register['name'] ) : '&ndash;';
	}

	public static function order_details( $order ) {
		if ( ! Plugin::is_pos_order( $order ) ) {
			return;
		}
		$register = $order->get_meta( Orders::META_REGISTER );
		$cashier  = get_userdata( (int) $order->get_meta( Orders::META_CASHIER ) );
		echo '<p><strong>' . esc_html__( 'Point of sale', 'shoptill' ) . '</strong><br>';
		if ( is_array( $register ) ) {
			echo esc_html( trim( $register['name'] . ( $register['outlet'] ? ' · ' . $register['outlet'] : '' ) ) ) . '<br>';
		}
		if ( $cashier ) {
			/* translators: %s: cashier name */
			echo esc_html( sprintf( __( 'Cashier: %s', 'shoptill' ), $cashier->display_name ) ) . '<br>';
		}
		foreach ( (array) $order->get_meta( Orders::META_PAYMENTS ) as $payment ) {
			if ( ! isset( $payment['label'], $payment['amount'] ) ) {
				continue;
			}
			echo esc_html( $payment['label'] ) . ': ' . wp_kses_post( wc_price( $payment['amount'] ) );
			if ( isset( $payment['tendered'] ) ) {
				/* translators: 1: cash tendered, 2: change given */
				echo ' ' . wp_kses_post( sprintf( __( '(tendered %1$s, change %2$s)', 'shoptill' ), wc_price( $payment['tendered'] ), wc_price( $payment['change'] ) ) );
			}
			echo '<br>';
		}
		if ( 'yes' === $order->get_meta( Orders::META_OFFLINE ) ) {
			echo esc_html__( 'Taken offline and synced later.', 'shoptill' );
		}
		echo '</p>';
	}

	public static function product_field() {
		woocommerce_wp_checkbox(
			array(
				'id'          => Catalog::META_HIDDEN,
				'label'       => __( 'Hide from the till', 'shoptill' ),
				'description' => __( 'Keep this product off the POS. It still sells online.', 'shoptill' ),
			)
		);
	}

	public static function save_product_field( \WC_Product $product ) {
		// WooCommerce checked the nonce before this action runs.
		$product->update_meta_data( Catalog::META_HIDDEN, isset( $_POST[ Catalog::META_HIDDEN ] ) ? 'yes' : 'no' ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
	}

	public static function admin_bar( \WP_Admin_Bar $bar ) {
		if ( current_user_can( Plugin::CAP_USE ) ) {
			$bar->add_node(
				array(
					'id'    => 'shoptill',
					'title' => __( 'Open POS', 'shoptill' ),
					'href'  => App::url(),
				)
			);
		}
	}
}
