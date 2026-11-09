<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/trait-order-discounts.php';

class Discount_Order extends \WC_Order {
	use Order_Discounts;
}
