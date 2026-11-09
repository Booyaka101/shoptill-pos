<?php
namespace ShopTill;

use WC_Product;
use WC_Tax;
use WP_Error;

defined( 'ABSPATH' ) || exit;

/**
 * Product, category and tax data in the compact shape the till caches offline.
 */
final class Catalog {

	const SELLABLE_TYPES = array( 'simple', 'variable', 'variation' );
	const META_HIDDEN    = '_shoptill_hidden';

	/**
	 * One page of products, oldest ID first.
	 *
	 * @param int      $page           1-based page, when $after isn't given.
	 * @param int      $per_page       Page size.
	 * @param int|null $modified_after Unix timestamp; only products changed after it.
	 * @param int|null $after          Only products with a higher ID. Unlike a page number, this doesn't skip
	 *                                 a product when one before it is deleted mid-download.
	 */
	public static function products( $page, $per_page, $modified_after = null, $after = null ) {
		$args = array(
			'type'     => self::SELLABLE_TYPES,
			'status'   => array( 'publish', 'private' ),
			'limit'    => $per_page,
			'page'     => null === $after ? $page : 1,
			'orderby'  => 'ID',
			'order'    => 'ASC',
			'paginate' => true,
		);
		$where = static function ( $sql ) use ( $after, $modified_after ) {
			global $wpdb;
			if ( null !== $after ) {
				$sql .= $wpdb->prepare( " AND {$wpdb->posts}.ID > %d", $after );
			}
			if ( $modified_after ) {
				// Publishing a scheduled product leaves its modified date as it was.
				$since = gmdate( 'Y-m-d H:i:s', (int) $modified_after );
				$sql  .= $wpdb->prepare( " AND ( {$wpdb->posts}.post_modified_gmt > %s OR {$wpdb->posts}.post_date_gmt > %s )", $since, $since );
			}
			return $sql;
		};
		if ( null !== $after || $modified_after ) {
			add_filter( 'posts_where', $where );
		}
		try {
			$result = wc_get_products( $args );
		} finally {
			remove_filter( 'posts_where', $where );
		}
		$last     = $result->products ? end( $result->products )->get_id() : null;
		$products = array();
		foreach ( $result->products as $product ) {
			if ( self::listed( $product ) ) {
				$products[] = self::product( $product );
			}
			// Variations carry their parent's categories and image, so they go out again when the parent changes.
			if ( $modified_after && $product->is_type( 'variable' ) ) {
				foreach ( array_filter( array_map( 'wc_get_product', $product->get_children() ) ) as $variation ) {
					if ( self::listed( $variation ) ) {
						$products[] = self::product( $variation );
					}
				}
			}
		}

		return array(
			'products'    => $products,
			'total'       => (int) $result->total,
			'total_pages' => (int) $result->max_num_pages,
			'next_after'  => count( $result->products ) < $per_page ? null : $last,
		);
	}

	/**
	 * Every product ID the till may sell, so it can drop ones deleted or unpublished since the last sync.
	 */
	public static function product_ids() {
		global $wpdb;
		$ids = array_map(
			'intval',
			wc_get_products(
				array(
					'type'   => array( 'simple', 'variable' ),
					'status' => array( 'publish', 'private' ),
					'limit'  => -1,
					'return' => 'ids',
				)
			)
		);
		$hidden = $wpdb->get_col( $wpdb->prepare( "SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value = 'yes'", self::META_HIDDEN ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$ids    = array_values( array_diff( $ids, array_map( 'intval', $hidden ) ) );
		if ( ! $ids ) {
			return array();
		}
		// Same rule as is_sellable(), in one query: a disabled variation is stored as private.
		$variations = $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'product_variation' AND post_status = 'publish' AND post_parent IN (" . implode( ',', $ids ) . ')' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return array_values( array_merge( $ids, array_map( 'intval', $variations ) ) );
	}

	/**
	 * Current stock for every stock-managed product. Stock changes from online orders do not touch a
	 * product's modified date, so the till polls this instead of relying on delta sync.
	 */
	public static function stock() {
		global $wpdb;
		// A variation whose stock the parent manages has no quantity of its own in the lookup table.
		$rows = $wpdb->get_results(
			"SELECT l.product_id, COALESCE( l.stock_quantity, pl.stock_quantity ) AS stock_quantity, l.stock_status
			FROM {$wpdb->wc_product_meta_lookup} l
			LEFT JOIN {$wpdb->posts} v ON v.ID = l.product_id AND v.post_type = 'product_variation'
			LEFT JOIN {$wpdb->wc_product_meta_lookup} pl ON pl.product_id = v.post_parent
			WHERE COALESCE( l.stock_quantity, pl.stock_quantity ) IS NOT NULL",
			ARRAY_A
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$out  = array();
		foreach ( $rows as $row ) {
			$out[] = array(
				'id'             => (int) $row['product_id'],
				'stock_quantity' => null === $row['stock_quantity'] ? null : (float) $row['stock_quantity'],
				'stock_status'   => $row['stock_status'],
			);
		}
		return $out;
	}

	public static function categories() {
		$terms = get_terms(
			array(
				'taxonomy'   => 'product_cat',
				'hide_empty' => true,
				'orderby'    => 'name',
			)
		);
		if ( is_wp_error( $terms ) ) {
			return array();
		}
		return array_map(
			static function ( $term ) {
				return array(
					'id'     => $term->term_id,
					'name'   => html_entity_decode( $term->name ),
					'parent' => $term->parent,
				);
			},
			// Filters can leave gaps or term-ID keys; JSON must still encode a list, not an object.
			array_values( $terms )
		);
	}

	/**
	 * Tax rates at the shop's base location for every tax class, plus the rounding rules WooCommerce
	 * applies to orders. The till repeats the same maths offline.
	 */
	public static function tax_config() {
		$classes = array_merge( array( '' ), WC_Tax::get_tax_class_slugs() );
		$rates   = array();
		foreach ( $classes as $class ) {
			$rates[ $class ] = array();
			foreach ( WC_Tax::get_base_tax_rates( $class ) as $rate_id => $rate ) {
				$rates[ $class ][] = array(
					'id'       => (int) $rate_id,
					'rate'     => (float) $rate['rate'],
					'label'    => $rate['label'],
					'compound' => 'yes' === $rate['compound'],
				);
			}
		}

		$class_names = array( '' => __( 'Standard', 'woocommerce' ) );
		foreach ( WC_Tax::get_tax_classes() as $name ) {
			$class_names[ sanitize_title( $name ) ] = $name;
		}

		return array(
			'enabled'            => wc_tax_enabled(),
			'prices_include_tax' => wc_prices_include_tax(),
			'round_at_subtotal'  => 'yes' === get_option( 'woocommerce_tax_round_at_subtotal' ),
			'rounding_mode'      => PHP_ROUND_HALF_DOWN === wc_get_tax_rounding_mode() ? 'half_down' : 'half_up',
			'rounding_precision' => wc_get_rounding_precision(),
			'price_decimals'     => wc_get_price_decimals(),
			'classes'            => $class_names,
			'rates'              => $rates,
		);
	}

	/**
	 * Private products are sold at the till but hidden online. A private variation is a disabled one.
	 */
	public static function is_sellable( WC_Product $product ) {
		if ( $product->is_type( 'variation' ) ) {
			return 'publish' === $product->get_status() && in_array( get_post_status( $product->get_parent_id() ), array( 'publish', 'private' ), true );
		}
		return in_array( $product->get_status(), array( 'publish', 'private' ), true );
	}

	/**
	 * Sellable and not hidden from the till in its product screen. A variation goes with its parent.
	 */
	private static function listed( WC_Product $product ) {
		$id = $product->is_type( 'variation' ) ? $product->get_parent_id() : $product->get_id();
		return self::is_sellable( $product ) && 'yes' !== get_post_meta( $id, self::META_HIDDEN, true );
	}

	public static function product( WC_Product $product ) {
		$is_variation = $product->is_type( 'variation' );
		$parent       = $is_variation ? wc_get_product( $product->get_parent_id() ) : null;
		$image_id     = $product->get_image_id() ? $product->get_image_id() : ( $parent ? $parent->get_image_id() : 0 );
		$image        = $image_id ? wp_get_attachment_image_src( $image_id, 'woocommerce_thumbnail' ) : false;

		$data = array(
			'id'                => $product->get_id(),
			'parent_id'         => $product->get_parent_id(),
			'type'              => $product->get_type(),
			'name'              => html_entity_decode( $product->get_name() ),
			'sku'               => $product->get_sku(),
			'gtin'              => method_exists( $product, 'get_global_unique_id' ) ? $product->get_global_unique_id() : '',
			'price'             => '' === $product->get_price() ? null : (float) $product->get_price(),
			'regular_price'     => '' === $product->get_regular_price() ? null : (float) $product->get_regular_price(),
			'on_sale'           => $product->is_on_sale(),
			'tax_status'        => $product->get_tax_status(),
			'tax_class'         => $product->get_tax_class(),
			'manage_stock'      => $product->managing_stock(),
			'stock_quantity'    => $product->managing_stock() ? (float) $product->get_stock_quantity() : null,
			'stock_id'          => $product->managing_stock() ? $product->get_stock_managed_by_id() : null,
			'stock_status'      => $product->get_stock_status(),
			'backorders'        => $product->backorders_allowed(),
			'sold_individually' => $product->is_sold_individually(),
			'image'             => $image ? $image[0] : null,
			'category_ids'      => array_map( 'intval', $parent ? $parent->get_category_ids() : $product->get_category_ids() ),
			'pinned'            => $parent ? $parent->is_featured() : $product->is_featured(),
			'status'            => get_post_status( $product->get_id() ),
		);

		// Costs are the shop's own margins: only staff WooCommerce trusts to edit products get them.
		if ( Costs::may_see() ) {
			$data['cost'] = Costs::product_cost( $product );
		}

		if ( $is_variation ) {
			$data['attributes'] = array();
			foreach ( $product->get_variation_attributes( false ) as $taxonomy => $value ) {
				$data['attributes'][ wc_attribute_label( $taxonomy, $product ) ] = self::attribute_value_label( $taxonomy, $value );
			}
		}
		if ( $product->is_type( 'variable' ) ) {
			$data['variation_ids'] = array_map( 'intval', $product->get_children() );
		}

		return $data;
	}

	/**
	 * A price, cost or stock change made at the till. Stock is set on whichever product holds it.
	 *
	 * @param WC_Product $product The product.
	 * @param array      $changes { regular_price?, sale_price? ('' ends a sale), cost? ('' clears it), stock?, stock_was? }.
	 */
	public static function update( WC_Product $product, array $changes ) {
		// Everything is checked before anything is saved, so a refused edit changes nothing.
		$prices = array_intersect_key( $changes, array( 'regular_price' => 0, 'sale_price' => 0 ) );
		foreach ( $prices as $key => $value ) {
			if ( 'sale_price' === $key && '' === $value ) {
				continue;
			}
			if ( ! is_numeric( $value ) || ! is_finite( (float) $value ) || $value < 0 ) {
				return new WP_Error( 'shoptill_price', __( 'Prices must be numbers, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$prices[ $key ] = wc_format_decimal( $value );
		}
		$cost = null;
		if ( array_key_exists( 'cost', $changes ) ) {
			if ( ! Costs::active() ) {
				return new WP_Error( 'shoptill_cost', __( 'No cost of goods plugin is active on the shop.', 'shoptill' ), array( 'status' => 422 ) );
			}
			// Reading a cost and writing one are the same privilege: a staff account the cost plugin
			// keeps out of its numbers must not be able to move the margins it never gets shown.
			if ( ! Costs::may_see() ) {
				return new WP_Error( 'shoptill_cost_forbidden', __( 'Your account cannot see or set costs.', 'shoptill' ), array( 'status' => 403 ) );
			}
			if ( '' !== $changes['cost'] && ( ! is_numeric( $changes['cost'] ) || ! is_finite( (float) $changes['cost'] ) || $changes['cost'] < 0 ) ) {
				return new WP_Error( 'shoptill_cost', __( 'The cost must be a number, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$cost = '' === $changes['cost'] ? '' : wc_format_decimal( $changes['cost'] );
		}
		$regular = $prices['regular_price'] ?? $product->get_regular_price();
		$sale    = $prices['sale_price'] ?? $product->get_sale_price();
		if ( $prices && ( '' === $regular || ( '' !== $sale && (float) $sale >= (float) $regular ) ) ) {
			return new WP_Error( 'shoptill_price', __( 'Give a regular price, and any sale price below it.', 'shoptill' ), array( 'status' => 422 ) );
		}
		if ( array_key_exists( 'stock', $changes ) ) {
			if ( ! $product->managing_stock() ) {
				return new WP_Error( 'shoptill_stock_untracked', __( 'WooCommerce does not count stock for this product.', 'shoptill' ), array( 'status' => 422 ) );
			}
			if ( ! is_numeric( $changes['stock'] ) || ! is_finite( (float) $changes['stock'] ) || $changes['stock'] < 0 ) {
				return new WP_Error( 'shoptill_stock', __( 'Stock must be a number, zero or more.', 'shoptill' ), array( 'status' => 422 ) );
			}
			if ( array_key_exists( 'stock_was', $changes ) && ( ! is_numeric( $changes['stock_was'] ) || ! is_finite( (float) $changes['stock_was'] ) ) ) {
				return new WP_Error( 'shoptill_stock', __( 'The previous stock must be a number.', 'shoptill' ), array( 'status' => 422 ) );
			}
			$counted = Orders::locked(
				'shoptill_stock',
				static function () use ( $product, $changes ) {
					wp_cache_delete( $product->get_stock_managed_by_id(), 'post_meta' );
					$current = wc_get_product( $product->get_id() );
					// A sale between opening the count and saving it would be undone by the new figure.
					if ( isset( $changes['stock_was'] ) && wc_stock_amount( $changes['stock_was'] ) !== wc_stock_amount( $current->get_stock_quantity() ) ) {
						return new WP_Error( 'shoptill_stock_changed', __( 'The stock changed while you were counting. Count it again.', 'shoptill' ), array( 'status' => 409 ) );
					}
					// Apply the count's adjustment atomically, not an absolute replacement. Online sales
					// don't take our lock, and any landing after this check must still come off the shelf.
					$adjustment = wc_stock_amount( $changes['stock'] ) - wc_stock_amount( $current->get_stock_quantity() );
					return wc_update_product_stock( $current, $adjustment, 'increase' );
				}
			);
			if ( is_wp_error( $counted ) ) {
				return $counted;
			}
		}
		if ( $prices ) {
			$product = wc_get_product( $product->get_id() );
			$product->set_regular_price( $regular );
			$product->set_sale_price( $sale );
			if ( isset( $prices['sale_price'] ) ) {
				// A sale set at the till starts now, and dates left from a scheduled one would stop it applying.
				$product->set_date_on_sale_from( '' );
				$product->set_date_on_sale_to( '' );
			}
			$product->save();
		}
		if ( null !== $cost ) {
			Costs::set_product_cost( $product, $cost );
		}
		return self::product( wc_get_product( $product->get_id() ) );
	}

	private static function attribute_value_label( $taxonomy, $value ) {
		if ( '' === $value ) {
			return __( 'Any', 'shoptill' );
		}
		if ( taxonomy_exists( $taxonomy ) ) {
			$term = get_term_by( 'slug', $value, $taxonomy );
			if ( $term ) {
				return html_entity_decode( $term->name );
			}
		}
		return $value;
	}
}
