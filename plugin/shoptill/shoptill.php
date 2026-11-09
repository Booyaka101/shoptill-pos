<?php
/**
 * Plugin Name:       ShopTill POS for WooCommerce
 * Description:       In-store point of sale that sells from your WooCommerce catalogue, keeps stock in sync and works offline.
 * Version:           0.10.1
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * Author:            ShopTill
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       shoptill
 * Domain Path:       /languages
 * WC requires at least: 8.0
 * WC tested up to:   11.1
 */

defined( 'ABSPATH' ) || exit;

define( 'SHOPTILL_VERSION', '0.10.1' );
define( 'SHOPTILL_FILE', __FILE__ );
define( 'SHOPTILL_DIR', plugin_dir_path( __FILE__ ) );

spl_autoload_register(
	static function ( $class ) {
		if ( 0 !== strpos( $class, 'ShopTill\\' ) ) {
			return;
		}
		$slug = strtolower( str_replace( '_', '-', substr( $class, 9 ) ) );
		$file = SHOPTILL_DIR . 'includes/class-' . $slug . '.php';
		if ( is_readable( $file ) ) {
			require $file;
		}
	}
);

register_activation_hook( __FILE__, array( 'ShopTill\\Plugin', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'ShopTill\\Plugin', 'deactivate' ) );

add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

add_action(
	'plugins_loaded',
	static function () {
		// Tokens outlive WooCommerce being switched off, and must stay confined to the till's API while it is.
		ShopTill\Auth::init();
		if ( class_exists( 'WooCommerce' ) ) {
			ShopTill\Plugin::init();
		}
	}
);
