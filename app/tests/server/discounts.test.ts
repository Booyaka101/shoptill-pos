import { describe, expect, it } from 'vitest';
import { wp } from '../wp';

describe.skipIf(!process.env.SHOPTILL_URL)('manual discounts after coupon edits', () => {
  it('leaves custom order and refund classes to their owning extensions', () => {
    const classes = JSON.parse(wp('eval', `echo wp_json_encode(array(
      apply_filters('woocommerce_order_class', 'Custom_Order', 'shop_order', 1),
      is_a(apply_filters('woocommerce_order_class', 'WC_Order_Refund', 'shop_order_refund', 1), 'WC_Order_Refund', true),
      is_subclass_of(apply_filters('woocommerce_order_class', '\\\\Automattic\\\\WooCommerce\\\\Admin\\\\Overrides\\\\Order', 'shop_order', 1), '\\\\Automattic\\\\WooCommerce\\\\Admin\\\\Overrides\\\\Order')
    ));`).toString());
    expect(classes).toEqual(['Custom_Order', true, true]);
  });

  it.each([
    { withCoupon: true, manual: 20, source: 'shoptill', expected: [70, 70, 80, 80] },
    { withCoupon: false, manual: 20, source: 'shoptill', expected: [70, 70, 80, 80] },
    { withCoupon: true, manual: 200, source: 'shoptill', expected: [0, 0, 0, 0] },
    { withCoupon: true, manual: 20, source: 'checkout', expected: [90, 90, 100, 100] },
    { withCoupon: false, manual: 20, source: 'shoptill', recordManual: false, expected: [72, 72, 80, 80] },
  ])('rebuilds coupons for $source, existing: $withCoupon, manual: $manual', ({ withCoupon, manual, source, expected, recordManual = true }) => {
    const result = JSON.parse(wp('eval', `
      $coupon = new WC_Coupon();
      $coupon->set_code('discount-edit-' . wp_generate_uuid4());
      $coupon->set_discount_type('percent');
      $coupon->set_amount(10);
      $coupon->save();
      $product = new WC_Product_Simple();
      $product->set_name('Manual discount fixture');
      $product->set_regular_price(100);
      $product->set_tax_status('none');
      $product->save();
      $order = new WC_Order();
      try {
        $order->set_created_via('${source}');
        $order->set_prices_include_tax(wc_prices_include_tax());
        $item = new WC_Order_Item_Product();
        $item->set_product($product);
        $item->set_tax_class('0');
        $item->set_subtotal(100);
        $item->set_total(100);
        $order->add_item($item);
        $order->calculate_totals();
        if (${withCoupon ? 'true' : 'false'} && is_wp_error($order->apply_coupon($coupon->get_code()))) throw new Exception('Fixture coupon refused');
        $item->set_total(max(0, (float) $item->get_total() - ${manual}));
        if (${recordManual ? 'true' : 'false'}) $item->update_meta_data('_shoptill_discount', ${manual});
        $order->calculate_totals();
        $order = wc_get_order($order->get_id());
        if (${withCoupon ? 'true' : 'false'}) {
          $order->recalculate_coupons();
        } else {
          $order->apply_coupon_using_edited_totals($coupon->get_code());
        }
        $first = (float) $order->get_total();
        $order = wc_get_order($order->get_id());
        $order->recalculate_coupons();
        $second = (float) $order->get_total();
        $order->remove_coupon($coupon->get_code());
        $removed = (float) $order->get_total();
        $order->recalculate_coupons();
        echo wp_json_encode(array($first, $second, $removed, (float) $order->get_total()));
      } finally {
        $order->delete(true);
        $coupon->delete(true);
        $product->delete(true);
      }
    `).toString());
    expect(result).toEqual(expected);
  }, 60_000);

  it.each([true, false])('uses recorded tax terms for a taxable discount, legacy metadata: %s', (legacy) => {
    const result = JSON.parse(wp('eval', `
      $original_mode = get_option('woocommerce_prices_include_tax');
      $product = new WC_Product_Simple();
      $product->set_name('Taxable manual discount fixture');
      $product->set_regular_price(100);
      $product->save();
      $coupon = new WC_Coupon();
      $coupon->set_code('tax-discount-edit-' . wp_generate_uuid4());
      $coupon->set_discount_type('percent');
      $coupon->set_amount(10);
      $coupon->save();
      $order = new WC_Order();
      try {
        $order->set_created_via('shoptill');
        $order->set_prices_include_tax(wc_prices_include_tax());
        $item = new WC_Order_Item_Product();
        $item->set_product($product);
        $item->set_subtotal(100);
        $item->set_total(100);
        $order->add_item($item);
        $order->calculate_totals();
        if (is_wp_error($order->apply_coupon($coupon->get_code()))) throw new Exception('Fixture coupon refused');
        $net = 20 / ($order->get_prices_include_tax() ? 1 + (float) $item->get_subtotal_tax() / 100 : 1);
        $item->set_total((float) $item->get_total() - $net);
        $item->update_meta_data('_shoptill_discount', 20);
        if (${legacy ? 'false' : 'true'}) $item->update_meta_data('_shoptill_discount_ex_tax', $net);
        $order->calculate_totals();
        $before = (float) $order->get_total();
        update_option('woocommerce_prices_include_tax', 'yes' === $original_mode ? 'no' : 'yes');
        $order = wc_get_order($order->get_id());
        $order->recalculate_coupons();
        $first = (float) $order->get_total();
        $order->recalculate_coupons();
        $item = current($order->get_items());
        $line = (float) $item->get_total();
        $item->set_total(55);
        $order->calculate_totals();
        echo wp_json_encode(array('before' => $before, 'first' => $first, 'net' => $net, 'line' => $line, 'edited' => (float) $item->get_total()));
      } finally {
        update_option('woocommerce_prices_include_tax', $original_mode);
        $order->delete(true);
        $coupon->delete(true);
        $product->delete(true);
      }
    `).toString());
    expect(result.first).toBeCloseTo(result.before, 2);
    expect(result.line).toBeCloseTo(90 - result.net, 5);
    expect(result.edited).toBe(55);
  }, 60_000);
});
