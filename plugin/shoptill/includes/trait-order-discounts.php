<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

/** Preserve POS line discounts only while WooCommerce rebuilds coupon totals. */
trait Order_Discounts {

	private $recalculating_pos_coupons = false;

	public function recalculate_coupons() {
		$previous = $this->recalculating_pos_coupons;
		$this->recalculating_pos_coupons = Plugin::is_pos_order( $this );
		try {
			return parent::recalculate_coupons();
		} finally {
			$this->recalculating_pos_coupons = $previous;
		}
	}

	public function calculate_totals( $and_taxes = true ) {
		if ( $this->recalculating_pos_coupons ) {
			$this->recalculating_pos_coupons = false;
			// Parent recalculate_coupons() resets each line before reaching this method.
			// Restore discounts before tax and order totals are saved, not in a second save.
			foreach ( $this->get_items() as $item ) {
				$discount = $item->get_meta( '_shoptill_discount_ex_tax' );
				if ( '' === $discount ) {
					$discount = (float) $item->get_meta( '_shoptill_discount' );
					// Older orders only stored the entered amount. Use their recorded tax,
					// not today's shop price mode or tax rates, to recover its net value.
					if ( $this->get_prices_include_tax() && (float) $item->get_subtotal() > 0 ) {
						$discount /= 1 + (float) $item->get_subtotal_tax() / (float) $item->get_subtotal();
					}
				}
				if ( is_numeric( $discount ) && is_finite( (float) $discount ) && $discount > 0 ) {
					$item->set_total( max( 0, (float) $item->get_total() - (float) $discount ) );
				}
			}
		}
		return parent::calculate_totals( $and_taxes );
	}

	public function apply_coupon_using_edited_totals( $raw_coupon ) {
		// Since WooCommerce 11.2 the admin treats edited totals as a new coupon base.
		// POS discounts have explicit metadata and must still go on after coupons.
		if ( Plugin::is_pos_order( $this ) ) {
			foreach ( $this->get_items() as $item ) {
				if ( (float) $item->get_meta( '_shoptill_discount' ) > 0 ) {
					return $this->apply_coupon( $raw_coupon );
				}
			}
		}
		if ( ! method_exists( '\WC_Order', 'apply_coupon_using_edited_totals' ) ) {
			return $this->apply_coupon( $raw_coupon );
		}
		return parent::apply_coupon_using_edited_totals( $raw_coupon );
	}
}
