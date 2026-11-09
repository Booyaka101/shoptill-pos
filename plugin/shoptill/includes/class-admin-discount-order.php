<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/trait-order-discounts.php';

class Admin_Discount_Order extends \Automattic\WooCommerce\Admin\Overrides\Order {
	use Order_Discounts;
}
