<?php
/**
 * Dev store fixture. Usage: wp eval-file /dev-scripts/seed.php <inclusive|exclusive> [round_at_subtotal yes|no]
 *
 * Idempotent: products are matched by SKU, tax rates are rebuilt each run.
 */

$mode     = $args[0] ?? 'exclusive';
$subtotal = $args[1] ?? 'no';

update_option( 'woocommerce_calc_taxes', 'yes' );
update_option( 'woocommerce_prices_include_tax', 'inclusive' === $mode ? 'yes' : 'no' );
update_option( 'woocommerce_tax_round_at_subtotal', $subtotal );
update_option( 'woocommerce_tax_based_on', 'billing' );
update_option( 'woocommerce_currency', 'inclusive' === $mode ? 'AUD' : 'USD' );
update_option( 'woocommerce_default_country', 'inclusive' === $mode ? 'AU:NSW' : 'US:CA' );
update_option( 'woocommerce_store_address', '12 Market Lane' );
update_option( 'woocommerce_store_city', 'inclusive' === $mode ? 'Sydney' : 'San Jose' );
update_option( 'woocommerce_store_postcode', 'inclusive' === $mode ? '2000' : '95112' );
update_option( 'woocommerce_manage_stock', 'yes' );
update_option( 'woocommerce_coming_soon', 'no' );

global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->prefix}woocommerce_tax_rates" );
$wpdb->query( "DELETE FROM {$wpdb->prefix}woocommerce_tax_rate_locations" );
WC_Cache_Helper::invalidate_cache_group( 'taxes' );

if ( 'inclusive' === $mode ) {
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'AU', 'tax_rate' => '10.0000', 'tax_rate_name' => 'GST', 'tax_rate_priority' => 1, 'tax_rate_compound' => 0, 'tax_rate_shipping' => 1, 'tax_rate_class' => '' ) );
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'AU', 'tax_rate' => '5.0000', 'tax_rate_name' => 'Reduced GST', 'tax_rate_priority' => 1, 'tax_rate_compound' => 0, 'tax_rate_shipping' => 0, 'tax_rate_class' => 'reduced-rate' ) );
} else {
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'US', 'tax_rate_state' => 'CA', 'tax_rate' => '7.2500', 'tax_rate_name' => 'CA State', 'tax_rate_priority' => 1, 'tax_rate_compound' => 0, 'tax_rate_shipping' => 0, 'tax_rate_class' => '' ) );
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'US', 'tax_rate_state' => 'CA', 'tax_rate' => '2.2500', 'tax_rate_name' => 'County', 'tax_rate_priority' => 2, 'tax_rate_compound' => 0, 'tax_rate_shipping' => 0, 'tax_rate_class' => '' ) );
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'US', 'tax_rate_state' => 'CA', 'tax_rate' => '1.5000', 'tax_rate_name' => 'Compound levy', 'tax_rate_priority' => 3, 'tax_rate_compound' => 1, 'tax_rate_shipping' => 0, 'tax_rate_class' => '' ) );
	WC_Tax::_insert_tax_rate( array( 'tax_rate_country' => 'US', 'tax_rate_state' => 'CA', 'tax_rate' => '3.3333', 'tax_rate_name' => 'Reduced', 'tax_rate_priority' => 1, 'tax_rate_compound' => 0, 'tax_rate_shipping' => 0, 'tax_rate_class' => 'reduced-rate' ) );
}

$cat_ids = array();
foreach ( array( 'Coffee', 'Bakery', 'Merch', 'Grocery' ) as $name ) {
	$term            = term_exists( $name, 'product_cat' );
	$term            = $term ? $term : wp_insert_term( $name, 'product_cat' );
	$cat_ids[ $name ] = (int) $term['term_id'];
}

function shoptill_seed_simple( $sku, $name, $price, $cat, $extra = array() ) {
	$id      = wc_get_product_id_by_sku( $sku );
	$product = $id ? wc_get_product( $id ) : new WC_Product_Simple();
	$product->set_name( $name );
	$product->set_sku( $sku );
	$product->set_regular_price( $price );
	$product->set_category_ids( array( $cat ) );
	$product->set_status( 'publish' );
	$product->set_tax_status( $extra['tax_status'] ?? 'taxable' );
	$product->set_tax_class( $extra['tax_class'] ?? '' );
	// Reset whatever a test run changed.
	$product->set_sale_price( $extra['sale'] ?? '' );
	$product->set_featured( false );
	$product->set_stock_status( 'instock' );
	if ( isset( $extra['stock'] ) ) {
		$product->set_manage_stock( true );
		$product->set_stock_quantity( $extra['stock'] );
	} else {
		$product->set_manage_stock( false );
	}
	if ( isset( $extra['gtin'] ) && method_exists( $product, 'set_global_unique_id' ) ) {
		$product->set_global_unique_id( $extra['gtin'] );
	}
	$product->set_sold_individually( ! empty( $extra['solo'] ) );
	return $product->save();
}

shoptill_seed_simple( 'FLAT-WHITE', 'Flat white', '4.95', $cat_ids['Coffee'], array( 'stock' => 500 ) );
shoptill_seed_simple( 'LONG-BLACK', 'Long black', '4.20', $cat_ids['Coffee'] );
shoptill_seed_simple( 'CROISSANT', 'Butter croissant', '3.33', $cat_ids['Bakery'], array( 'stock' => 40, 'gtin' => '9300601000017' ) );
shoptill_seed_simple( 'SOURDOUGH', 'Sourdough loaf', '8.99', $cat_ids['Bakery'], array( 'tax_class' => 'reduced-rate', 'stock' => 12 ) );
shoptill_seed_simple( 'BEANS-1KG', 'House blend beans 1kg', '42.00', $cat_ids['Grocery'], array( 'sale' => '37.77', 'stock' => 30, 'gtin' => '9300601000024' ) );
shoptill_seed_simple( 'MILK-2L', 'Milk 2L', '3.10', $cat_ids['Grocery'], array( 'tax_class' => 'zero-rate' ) );
shoptill_seed_simple( 'GIFT-CARD', 'Gift card', '25.00', $cat_ids['Merch'], array( 'tax_status' => 'none' ) );
shoptill_seed_simple( 'KEEPCUP', 'Reusable cup', '19.95', $cat_ids['Merch'], array( 'stock' => 8 ) );
shoptill_seed_simple( 'SIGNED-PRINT', 'Signed print', '18.50', $cat_ids['Merch'], array( 'stock' => 6, 'solo' => true ) );

// Flat white carries a photo, so the till's photo tiles and cart thumbnails have one to show.
$fw_id  = wc_get_product_id_by_sku( 'FLAT-WHITE' );
$upload = wp_upload_dir();
$file   = trailingslashit( $upload['basedir'] ) . 'shoptill-flat-white.png';
if ( ! file_exists( $file ) ) {
	file_put_contents( $file, base64_decode( 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIqSURBVHhe7dGxbSQxEERRBXaxXEJK8dKQfQKNBYTvrKbYzSKJMp6zxk4X/8fn3z//w+eDP8RaCWCWAGYJYJYAZglglgBmCWCWAGYJYJYAZglglgBmCWCWAGYJYJYAZglgdkSAr69/Mv7XbrYNwIeswG/sYLsAfLQO/KbTNgH4SCvwBgd7AD6KA29ayRqAD+HE21axBOD4nfDWbssDcPCOeHOnpQE4dGe8vcuyABx4Am7osCQAh52EW6olwBvcUq09AAediJsqtQbgkJNxW5UE+CVuq9IWgANuwI0VEuABbqzQEoCH34RbZyXAQ9w6qzwAD74RN89IAAE3z0gAATfPKA3AQ2/G7aoEEHG7KgFE3K5KABG3qxJAxO2qBBBxuyoBRNyuKgvAA2/H/aqyAAOPvBm3qxJAxO2qBBBxuyoBRNyuSgARt6sSQMTtqgQQcbuqNMDAQ2/EzTMSQMDNMxJAwM0zygMMPPgm3DorAR7i1lktAQYefgNurJAAD3BjhbYAAwecjNuqJMAvcVuV1gADh5yImyq1Bxg46CTcUi0B3uCWaksCDBx2Am7osCzAwIE74+1dlgYYOHRHvLnT8gADB++Et3azBHjheCfetoo1wMCHcOBNK9kDvPBRVuANDtsEeOEjdeA3nbYL8MJHq8Bv7GDbAD/xIZ/gf+3miAA3SwCzBDBLALMEMEsAswQwSwCzBDBLALMEMEsAswQwSwCzBDBLALMEMEsAs2+lSem1TSKbggAAAABJRU5ErkJggg==' ) );
}
if ( ! get_post_thumbnail_id( $fw_id ) ) {
	$att_id = wp_insert_attachment( array( 'post_title' => 'shoptill-flat-white', 'post_mime_type' => 'image/png' ), $file );
	if ( $att_id && ! is_wp_error( $att_id ) ) {
		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata( $att_id, wp_generate_attachment_metadata( $att_id, $file ) );
		set_post_thumbnail( $fw_id, $att_id );
	}
}

// Variable tee.
$attr = new WC_Product_Attribute();
$attr->set_name( 'Size' );
$attr->set_options( array( 'S', 'M', 'L' ) );
$attr->set_visible( true );
$attr->set_variation( true );

$tee_id = wc_get_product_id_by_sku( 'TEE' );
$tee    = $tee_id ? wc_get_product( $tee_id ) : new WC_Product_Variable();
$tee->set_name( 'Logo tee' );
$tee->set_sku( 'TEE' );
$tee->set_attributes( array( $attr ) );
$tee->set_category_ids( array( $cat_ids['Merch'] ) );
$tee->set_status( 'publish' );
$tee_id = $tee->save();

foreach ( array( 'S' => '29.00', 'M' => '29.00', 'L' => '31.50' ) as $size => $price ) {
	$sku = 'TEE-' . $size;
	$vid = wc_get_product_id_by_sku( $sku );
	$var = $vid ? wc_get_product( $vid ) : new WC_Product_Variation();
	$var->set_parent_id( $tee_id );
	$var->set_sku( $sku );
	$var->set_attributes( array( 'size' => $size ) );
	$var->set_regular_price( $price );
	$var->set_manage_stock( true );
	$var->set_stock_quantity( 10 );
	$var->set_status( 'publish' );
	$var->save();
}
WC_Product_Variable::sync( $tee_id );

foreach ( array(
	'TENOFF'  => array( 'percent', '10' ),
	'FIVEOFF' => array( 'fixed_cart', '5' ),
	'CUP2'    => array( 'fixed_product', '2' ),
	'ONCE'    => array( 'percent', '5' ),
	'SOLO'    => array( 'percent', '15' ),
	'STAFF'   => array( 'percent', '20' ),
	'JOONLY'  => array( 'percent', '20' ),
	'ONEEACH' => array( 'fixed_cart', '1' ),
) as $code => $def ) {
	$id     = wc_get_coupon_id_by_code( $code );
	$coupon = new WC_Coupon( $id ? $id : 0 );
	$coupon->set_code( $code );
	$coupon->set_discount_type( $def[0] );
	$coupon->set_amount( $def[1] );
	if ( 'CUP2' === $code ) {
		$coupon->set_product_ids( array( wc_get_product_id_by_sku( 'KEEPCUP' ) ) );
	}
	$coupon->set_usage_limit( 'ONCE' === $code ? 1 : 0 );
	$coupon->set_usage_count( 0 );
	$coupon->set_individual_use( 'SOLO' === $code );
	// STAFF is for the cashier's own email, which must not let them give it to anyone.
	$coupon->set_email_restrictions( array( 'STAFF' => array( 'cashier@example.com' ), 'JOONLY' => array( 'jo@example.com' ) )[ $code ] ?? array() );
	$coupon->set_usage_limit_per_user( 'ONEEACH' === $code ? 1 : 0 );
	$coupon->save();
	delete_post_meta( $coupon->get_id(), '_used_by' );
}

// The dev shop has no mail server, so mail counts as sent. A test can still make it fail.
wp_mkdir_p( WPMU_PLUGIN_DIR );
file_put_contents( WPMU_PLUGIN_DIR . '/shoptill-dev-mail.php', "<?php add_filter( 'pre_wp_mail', function ( \$sent ) { return null === \$sent ? true : \$sent; }, 99 );\n" );
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_%shoptill\\_mail\\_%'" );

if ( ! get_user_by( 'login', 'cashier' ) ) {
	wp_insert_user( array( 'user_login' => 'cashier', 'user_pass' => 'cashier-pass', 'user_email' => 'cashier@example.com', 'display_name' => 'Casey Cashier', 'role' => 'shoptill_cashier' ) );
}
if ( ! get_user_by( 'email', 'jo@example.com' ) ) {
	$c = new WC_Customer();
	$c->set_email( 'jo@example.com' );
	$c->set_username( 'jo' );
	$c->set_password( wp_generate_password() );
	$c->set_first_name( 'Jo' );
	$c->set_last_name( 'Bloggs' );
	$c->set_billing_first_name( 'Jo' );
	$c->set_billing_last_name( 'Bloggs' );
	$c->set_billing_email( 'jo@example.com' );
	$c->set_billing_phone( '0412555123' );
	// A far-away billing address: POS sales must still be taxed at the shop.
	$c->set_billing_country( 'NZ' );
	$c->save();
}

WP_CLI::success( "Seeded ($mode prices, round at subtotal: $subtotal)." );
