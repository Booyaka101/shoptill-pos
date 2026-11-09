<?php
namespace ShopTill;

use WC_Order;
use WC_Order_Item_Product;
use WC_Product;

defined( 'ABSPATH' ) || exit;

/**
 * Product costs from a cost-of-goods plugin, so the till's reports can count what a day's sales
 * cost the shop. Reads and writes the same places "Cost of Goods for WooCommerce" (WPFactory) and
 * "WooCommerce Cost of Goods" (SkyVerge) keep theirs, so their own reports see till sales too.
 *
 * A product with no cost is missing information, not free to sell: costs come back null rather
 * than zero, and the report keeps what was sold without one apart.
 */
final class Costs {

	const ALG_COST = '_alg_wc_cog_cost';
	const ALG_ITEM = '_alg_wc_cog_item_cost';
	const COG_COST = '_wc_cog_cost';
	const COG_ITEM = '_wc_cog_item_cost';

	/**
	 * Whether a cost plugin the till knows is active. Costs are only offered and reported while
	 * one is, so the till never invents meta nobody reads.
	 */
	public static function active() {
		return function_exists( 'wpfcogs' ) || function_exists( 'alg_wc_cog' ) || class_exists( 'WC_COG' );
	}

	/**
	 * Staff who may see costs and profit: anyone WooCommerce trusts to edit products, and anyone
	 * the cost plugin itself allows, where it keeps its own list.
	 */
	public static function may_see() {
		if ( ! self::active() || ! current_user_can( 'edit_products' ) ) {
			return false;
		}
		return ! function_exists( 'wpfcogs_is_user_allowed' ) || wpfcogs_is_user_allowed();
	}

	/**
	 * SkyVerge's plugin, and only it, on the shop. Its meta keys are then the ones costs belong in.
	 */
	private static function skyverge_only() {
		return class_exists( 'WC_COG' ) && ! function_exists( 'wpfcogs' ) && ! function_exists( 'alg_wc_cog' );
	}

	/**
	 * The product meta key the shop's cost plugin reads. WPFactory's plugin (either generation) is
	 * the common one; SkyVerge's is read when it's the only one present.
	 */
	private static function product_key() {
		return self::skyverge_only() ? self::COG_COST : self::ALG_COST;
	}

	/**
	 * The order item meta key that goes with product_key(): a cost stamped where the plugin that
	 * keeps the product's cost does not read it is a cost that plugin's own reports never see.
	 */
	private static function item_key() {
		return self::skyverge_only() ? self::COG_ITEM : self::ALG_ITEM;
	}

	/**
	 * A product's unit cost, or null when none is set. A variation without its own falls back to
	 * its parent's, as both plugins do.
	 */
	public static function product_cost( $product ) {
		if ( ! $product ) {
			return null;
		}
		$ids = array( $product->get_id() );
		if ( $product->get_parent_id() ) {
			$ids[] = $product->get_parent_id();
		}
		foreach ( $ids as $id ) {
			foreach ( array( self::product_key(), self::COG_COST ) as $key ) {
				$cost = get_post_meta( $id, $key, true );
				if ( '' !== $cost && is_numeric( $cost ) ) {
					return (float) $cost;
				}
			}
		}
		return null;
	}

	/**
	 * Saves a product's unit cost where its plugin reads it. An empty string clears it.
	 */
	public static function set_product_cost( WC_Product $product, $cost ) {
		$id = $product->get_id();
		if ( '' === $cost ) {
			delete_post_meta( $id, self::product_key() );
			return;
		}
		update_post_meta( $id, self::product_key(), wc_format_decimal( (float) $cost ) );
	}

	/**
	 * The unit cost frozen onto an order item when it was sold, or null.
	 */
	public static function item_cost( $item ) {
		foreach ( array( self::ALG_ITEM, self::COG_ITEM ) as $key ) {
			$cost = $item->get_meta( $key );
			if ( '' !== $cost && null !== $cost && is_numeric( $cost ) ) {
				return (float) $cost;
			}
		}
		return null;
	}

	/**
	 * Freezes a cost the till itself had when the sale was made, for a sale that syncs after the
	 * product's cost has moved: it is costed as the stock it actually sold. stamp_items() then
	 * leaves the item alone, having found a cost already on it.
	 */
	public static function freeze( WC_Order_Item_Product $item, $cost ) {
		$item->update_meta_data( self::item_key(), (float) $cost );
	}

	/**
	 * Stamps each of the order's items with the cost as it stands, in the plugin's own meta, when
	 * the plugin hasn't. Till orders are created straight at their final status, which the plugin's
	 * per-item stamping never sees, so its per-product reports would count them as costing nothing.
	 */
	public static function stamp_items( WC_Order $order ) {
		if ( ! self::active() ) {
			return;
		}
		$stamped = false;
		foreach ( $order->get_items() as $item ) {
			if ( null !== self::item_cost( $item ) ) {
				continue;
			}
			$product = $item->get_product();
			if ( ! $product ) {
				continue;
			}
			$cost = self::product_cost( $product );
			if ( null === $cost ) {
				continue;
			}
			// The filter WPFactory's own stamping applies, so shops that adjust costs there are followed.
			$cost = apply_filters( 'wpfcogs_order_item_cost', $cost, $product->get_id(), $item->get_id(), $item );
			$item->update_meta_data( self::item_key(), (float) $cost );
			$item->save();
			$stamped = true;
		}
		return $stamped;
	}
}
