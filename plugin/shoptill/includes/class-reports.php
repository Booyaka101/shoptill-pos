<?php
namespace ShopTill;

use WP_REST_Request;

defined( 'ABSPATH' ) || exit;

/**
 * End-of-day takings for the till: sales and refunds by payment method, and sales by product and
 * cashier, optionally for one register.
 */
final class Reports {

	/**
	 * Every status a sale can be in once it's made, custom ones from other plugins included.
	 */
	private static function statuses() {
		return array_values( array_diff( array_keys( wc_get_order_statuses() ), array( 'wc-pending', 'wc-failed', 'wc-cancelled', 'wc-checkout-draft' ) ) );
	}

	public static function summary( WP_REST_Request $request ) {
		$tz    = wp_timezone();
		$day   = $request['date'] ? Plugin::text( $request['date'] ) : wp_date( 'Y-m-d' );
		$start = date_create_immutable_from_format( '!Y-m-d', $day, $tz );
		if ( ! $start || $start->format( 'Y-m-d' ) !== $day ) {
			return new \WP_Error( 'shoptill_date', __( 'Date must be YYYY-MM-DD.', 'shoptill' ), array( 'status' => 400 ) );
		}
		$end         = $start->modify( '+1 day' );
		$register_id = Plugin::text( $request['register_id'] );
		$range       = $start->getTimestamp() . '...' . ( $end->getTimestamp() - 1 );
		// Costs and profit are the shop's own margins: cashiers get the takings, managers the maths behind them.
		$with_costs = Costs::may_see();

		$orders = self::each_order(
			array(
				'created_via'  => Plugin::SOURCE,
				'date_created' => $range,
				'status'       => self::statuses(),
				'type'         => 'shop_order',
			)
		);

		$by_method  = array();
		$by_product = array();
		$by_cashier = array();
		$totals     = array(
			'orders'      => 0,
			'items'       => 0,
			'gross'       => 0.0,
			'tax'         => 0.0,
			'discounts'   => 0.0,
			'refunds'     => 0.0,
			'net'         => 0.0,
			'owed'        => 0.0,
			'repaid'      => 0.0,
			// Refunds at the till on web orders, whose sales were never in gross.
			'web_refunds' => 0.0,
			// Cash put into or taken out of the drawer outside a sale.
			'paid_in'     => 0.0,
			'paid_out'    => 0.0,
			// Delivery charges with their tax, which the product breakdown doesn't count.
			'shipping'    => 0.0,
			'tips'        => 0.0,
			// What the day's sales cost the shop, and what was sold with no cost known. Staff only.
			'cost'        => 0.0,
			'uncosted'    => 0.0,
		);

		foreach ( $orders as $order ) {
			if ( ! self::on_register( $order, $register_id ) ) {
				continue;
			}
			++$totals['orders'];
			$totals['items']     += $order->get_item_count();
			$totals['gross']     += (float) $order->get_total();
			$totals['tax']       += (float) $order->get_total_tax();
			$totals['shipping']  += (float) $order->get_shipping_total() + (float) $order->get_shipping_tax();
			// A tip rides the order as a fee: in the day's takings, apart from products.
			$fees = 0.0;
			foreach ( $order->get_fees() as $fee ) {
				$fees += (float) $fee->get_total() + (float) $fee->get_total_tax();
				if ( 'Tip' === $fee->get_name() ) {
					$totals['tips'] += (float) $fee->get_total();
				}
			}
			// In the terms the till showed them, so gross less discounts reads right.
			$totals['discounts'] += (float) $order->get_discount_total() + ( $order->get_prices_include_tax() ? (float) $order->get_discount_tax() : 0 );
			foreach ( Orders::payments( $order ) as $payment ) {
				// Taken later: counted below, on the day and at the register it was taken.
				if ( isset( $payment['method'] ) && empty( $payment['paid_at'] ) ) {
					self::add( $by_method, $payment['method'], $payment['label'], (float) $payment['amount'], 0 );
				}
			}
			$totals['owed'] += Orders::owed( $order );

			$lines = array();
			foreach ( $order->get_items() as $item ) {
				$id  = $item->get_variation_id() ? $item->get_variation_id() : $item->get_product_id();
				$key = $id ? (string) $id : 'custom:' . $item->get_name();
				if ( ! isset( $by_product[ $key ] ) ) {
					$product            = $item->get_product();
					$by_product[ $key ] = array(
						'key'   => $key,
						'name'  => $item->get_name(),
						'sku'   => $product ? $product->get_sku() : '',
						'qty'      => 0,
						'refunded' => 0,
						'sales'    => 0.0,
						'cost'     => 0.0,
					);
				}
				$returned = abs( (float) $order->get_qty_refunded_for_item( $item->get_id() ) );
				$by_product[ $key ]['qty'] += $item->get_quantity();
				$by_product[ $key ]['refunded'] += $returned;
				$lines[ $key ]               = ( $lines[ $key ] ?? 0 ) + (float) $order->get_line_total( $item, true, true );
				if ( $with_costs ) {
					$cost = Costs::item_cost( $item );
					if ( null === $cost ) {
						// What was sold without a cost known is kept apart, so profit is never flattered by it.
						$totals['uncosted'] += (float) $order->get_line_total( $item, true, true );
						$by_product[ $key ]['uncosted'] = true;
					} else {
						// Net of returns, like the day's totals, so the table's column adds up to them.
						$kept = max( 0, $item->get_quantity() - $returned );
						$by_product[ $key ]['cost'] += $cost * $kept;
						$totals['cost'] += $cost * $kept;
					}
				}
			}
			if ( $lines ) {
				// Tax rounds per rate across the whole order, so the biggest line takes the cent or two
				// that leaves. Fees are not product sales, even when a tiny tip fits inside the tolerance.
				$left = (float) $order->get_total() - (float) $order->get_shipping_total() - (float) $order->get_shipping_tax() - $fees - array_sum( $lines );
				if ( abs( $left ) <= Orders::tolerance( $order ) ) {
					$lines[ array_search( max( $lines ), $lines, true ) ] += $left;
				}
				foreach ( $lines as $key => $sales ) {
					$by_product[ $key ]['sales'] += $sales;
				}
			}

			$cashier = (int) $order->get_meta( Orders::META_CASHIER );
			if ( ! isset( $by_cashier[ $cashier ] ) ) {
				$user                   = $cashier ? get_userdata( $cashier ) : false;
				$by_cashier[ $cashier ] = array(
					'id'     => $cashier,
					'name'   => $user ? $user->display_name : __( 'Unknown', 'shoptill' ),
					'orders' => 0,
					'sales'  => 0.0,
				);
			}
			++$by_cashier[ $cashier ]['orders'];
			$by_cashier[ $cashier ]['sales'] += (float) $order->get_total();
		}

		// Web orders too, when their customer paid at the till.
		$repaid = self::each_order(
			array(
				'type'       => 'shop_order',
				// The legacy posts store silently drops meta_query.
				'meta_key'   => Orders::META_PAID_DAY, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value' => $start->format( 'Y-m-d' ), // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			)
		);
		foreach ( $repaid as $order ) {
			foreach ( Orders::payments( $order ) as $payment ) {
				$at = isset( $payment['paid_at'] ) ? (int) $payment['paid_at'] : 0;
				if ( $at < $start->getTimestamp() || $at >= $end->getTimestamp() || ( '' !== $register_id && ( $payment['register_id'] ?? '' ) !== $register_id ) ) {
					continue;
				}
				$totals['repaid'] += (float) $payment['amount'];
				self::add( $by_method, $payment['method'], $payment['label'], (float) $payment['amount'], 0 );
			}
		}

		// Refunds count on the day they are given, whichever day the sale was.
		$refund_pages = self::pages(
			array(
				'type'         => 'shop_order_refund',
				'date_created' => $range,
			)
		);
		// A method switched off since still names the refunds it gave.
		$methods = Settings::payment_methods() + Settings::method_labels();
		foreach ( $refund_pages as $refunds ) {
			$parents = array_unique(
				array_map(
					static function ( $refund ) {
						return $refund->get_parent_id();
					},
					$refunds
				)
			);
			// One query for which of the refunded orders were till sales, rather than loading each one.
			$pos = $parents ? wc_get_orders(
				array(
					'created_via' => Plugin::SOURCE,
					'post__in'    => $parents,
					'type'        => 'shop_order',
					'limit'       => -1,
					'return'      => 'ids',
				)
			) : array();
			// A refund with no register of its own was given in wp-admin; it still counts against
			// the register its sale was rung up on. Those parents are few, and loading them one
			// refund at a time is a query per refund on a busy day, so they are loaded together.
			$own_register = array();
			$unsettled    = array();
			foreach ( $refunds as $refund ) {
				if ( $refund->get_meta( Orders::META_REGISTER ) ) {
					$own_register[ $refund->get_id() ] = true;
				} elseif ( in_array( $refund->get_parent_id(), $pos, true ) ) {
					$unsettled[] = $refund->get_parent_id();
				}
			}
			$sale_register = array();
			foreach ( array_chunk( array_unique( $unsettled ), 200 ) as $chunk ) {
				$loaded = wc_get_orders(
					array(
						'post__in' => $chunk,
						'limit'    => -1,
					)
				);
				foreach ( $loaded as $parent ) {
					$sale_register[ $parent->get_id() ] = self::on_register( $parent, $register_id );
				}
			}
			foreach ( $refunds as $refund ) {
				// A web order refunded at the till paid its cash out of the drawer too.
				$at_till = in_array( $refund->get_parent_id(), $pos, true ) || isset( $own_register[ $refund->get_id() ] );
				if ( ! $at_till ) {
					continue;
				}
				$on_register = self::on_register( $refund, $register_id )
					|| ( '' !== $register_id && ! empty( $sale_register[ $refund->get_parent_id() ] ) );
				if ( ! $on_register ) {
					continue;
				}
				$amount = (float) $refund->get_amount();
				if ( in_array( $refund->get_parent_id(), $pos, true ) ) {
					$totals['refunds'] += $amount;
					$totals['tax']     += (float) $refund->get_total_tax();
				} else {
					$totals['web_refunds'] += $amount;
				}
				// What came off a debt was never in the drawer, so only the rest counts against a method.
				$paid_back = $amount - Orders::off_owed( $refund );
				if ( $paid_back > 0.001 ) {
					$method = $refund->get_meta( Orders::META_REFUND_BY );
					$method = $method ? $method : 'unrecorded';
					self::add( $by_method, $method, $methods[ $method ] ?? __( 'Not recorded', 'shoptill' ), 0, $paid_back );
				}
			}
		}

		$here  = static function ( $entry ) use ( $register_id ) {
			return '' === $register_id || $entry['register_id'] === $register_id;
		};
		$moves  = array_values( array_filter( (array) get_option( self::day_option( 'cash', $day ), array() ), $here ) );
		$closes = array_values( array_filter( (array) get_option( self::day_option( 'closes', $day ), array() ), $here ) );
		// Cash moved after the drawer was counted is not in what that count compared against.
		$last_close = array();
		foreach ( $closes as $close ) {
			$last_close[ $close['register_id'] ] = max( $last_close[ $close['register_id'] ] ?? 0, (float) $close['at'] );
		}
		foreach ( $moves as &$move ) {
			if ( isset( $last_close[ $move['register_id'] ] ) && (float) $move['at'] > $last_close[ $move['register_id'] ] ) {
				$move['after_close'] = true;
			}
		}
		unset( $move );
		foreach ( $moves as $move ) {
			$totals[ $move['amount'] > 0 ? 'paid_in' : 'paid_out' ] += abs( $move['amount'] );
		}

		$totals['net'] = $totals['gross'] - $totals['refunds'];
		$decimals      = wc_get_price_decimals();
		foreach ( array( 'gross', 'tax', 'discounts', 'refunds', 'net', 'owed', 'repaid', 'web_refunds', 'paid_in', 'paid_out', 'shipping', 'tips' ) as $key ) {
			$totals[ $key ] = round( $totals[ $key ], $decimals );
		}
		if ( $with_costs ) {
			$totals['cost']     = round( $totals['cost'], $decimals );
			$totals['uncosted'] = round( $totals['uncosted'], $decimals );
			$totals['profit']   = round( $totals['net'] - $totals['cost'], $decimals );
		} else {
			unset( $totals['cost'], $totals['uncosted'] );
			foreach ( $by_product as &$row ) {
				unset( $row['cost'], $row['uncosted'] );
			}
			unset( $row );
		}

		$by_sales = static function ( $a, $b ) {
			return $b['sales'] <=> $a['sales'];
		};
		uasort( $by_product, $by_sales );
		uasort( $by_cashier, $by_sales );

		return array(
			'date'        => $start->format( 'Y-m-d' ),
			'register_id' => $register_id,
			'totals'      => $totals,
			'closes'      => $closes,
			'cash_moves'  => $moves,
			'by_method'   => self::rounded( $by_method, array( 'sales', 'refunds' ), $decimals ),
			'by_product'  => self::rounded( $by_product, $with_costs ? array( 'sales', 'cost' ) : array( 'sales' ), $decimals ),
			'by_cashier'  => self::rounded( $by_cashier, array( 'sales' ), $decimals ),
		);
	}

	/**
	 * Records a register's drawer count against the cash its day says should be there. A recount is kept
	 * alongside the first, so a drawer that came up short and then balanced shows both.
	 */
	public static function close( WP_REST_Request $request ) {
		$register_id = Plugin::text( $request['register_id'] );
		if ( ! Settings::register( $register_id ) ) {
			return new \WP_Error( 'shoptill_register', __( 'Unknown register.', 'shoptill' ), array( 'status' => 400 ) );
		}
		if ( Plugin::text( $request['date'] ) > wp_date( 'Y-m-d' ) ) {
			return new \WP_Error( 'shoptill_date', __( "That day hasn't come yet.", 'shoptill' ), array( 'status' => 400 ) );
		}
		foreach ( array( $request['counted'], null === $request['float'] ? 0 : $request['float'] ) as $amount ) {
			if ( ! is_numeric( $amount ) || ! is_finite( (float) $amount ) || $amount < 0 ) {
				return new \WP_Error( 'shoptill_amount', __( 'Enter the cash counted as an amount.', 'shoptill' ), array( 'status' => 400 ) );
			}
		}
		$summary = self::summary( $request );
		if ( is_wp_error( $summary ) ) {
			return $summary;
		}

		$decimals = wc_get_price_decimals();
		$cash     = 0.0;
		foreach ( $summary['by_method'] as $method ) {
			if ( 'cash' === $method['method'] ) {
				$cash = $method['sales'] - $method['refunds'];
			}
		}
		$float    = round( (float) $request['float'], $decimals );
		$counted  = round( (float) $request['counted'], $decimals );
		$expected = round( $float + $cash + $summary['totals']['paid_in'] - $summary['totals']['paid_out'], $decimals );
		$user     = wp_get_current_user();
		$close    = array(
			'register_id'  => $register_id,
			'float'        => $float,
			'counted'      => $counted,
			'expected'     => $expected,
			'difference'   => round( $counted - $expected, $decimals ),
			'cashier'      => $user->ID,
			'cashier_name' => $user->display_name,
			// A float, not a whole second: a count and the cash moved after it can happen within one.
			'at'           => microtime( true ),
		);
		return self::append_once( self::day_option( 'closes', $summary['date'] ), $close, $request );
	}

	/**
	 * Records cash put into or taken out of a register's drawer outside a sale, such as change fetched
	 * from the bank or a delivery paid for out of the till. Taken out is a negative amount.
	 */
	public static function move_cash( WP_REST_Request $request ) {
		$register_id = Plugin::text( $request['register_id'] );
		if ( ! Settings::register( $register_id ) ) {
			return new \WP_Error( 'shoptill_register', __( 'Unknown register.', 'shoptill' ), array( 'status' => 400 ) );
		}
		$decimals = wc_get_price_decimals();
		$amount   = is_numeric( $request['amount'] ) ? round( (float) $request['amount'], $decimals ) : 0.0;
		if ( ! is_finite( $amount ) || 0.0 === $amount ) {
			return new \WP_Error( 'shoptill_amount', __( 'Enter the cash as an amount.', 'shoptill' ), array( 'status' => 400 ) );
		}
		$reason = mb_substr( sanitize_text_field( Plugin::text( $request['reason'] ) ), 0, 200 );
		if ( '' === $reason ) {
			return new \WP_Error( 'shoptill_reason', __( 'Say what the cash was for.', 'shoptill' ), array( 'status' => 400 ) );
		}
		// Sent for the day on the till's screen, so a retry after midnight isn't taken for a new movement.
		$day = Plugin::text( $request['date'] );
		if ( wp_date( 'Y-m-d' ) !== $day ) {
			$done = preg_match( '/^\d{4}-\d{2}-\d{2}$/', $day ) ? self::sent_before( (array) get_option( self::day_option( 'cash', $day ), array() ), $request ) : null;
			return $done ? $done : new \WP_Error( 'shoptill_date', __( "It's a new day. Open today's report to record cash.", 'shoptill' ), array( 'status' => 409 ) );
		}
		$user = wp_get_current_user();
		$move = array(
			'register_id'  => $register_id,
			'amount'       => $amount,
			'reason'       => $reason,
			'cashier'      => $user->ID,
			'cashier_name' => $user->display_name,
			// A float, so a move made a moment after a count lands after it.
			'at'           => microtime( true ),
		);
		return self::append_once( self::day_option( 'cash', $day ), $move, $request );
	}

	/**
	 * Adds an entry to one of a day's lists, once however many times its request is sent.
	 */
	private static function append_once( $option, array $entry, WP_REST_Request $request ) {
		return Orders::locked(
			$option,
			static function () use ( $option, $entry, $request ) {
				// A summary earlier in the request cached the list as it was before the lock, perhaps before another till's entry.
				wp_cache_delete( $option, 'options' );
				wp_cache_delete( 'notoptions', 'options' );
				$list = (array) get_option( $option, array() );
				$done = self::sent_before( $list, $request );
				if ( $done ) {
					return $done;
				}
				$entry['request_id'] = self::request_id( $request );
				$list[]              = $entry;
				if ( ! update_option( $option, $list, false ) ) {
					return new \WP_Error( 'shoptill_not_saved', __( 'The shop could not save that. Try again.', 'shoptill' ), array( 'status' => 500 ) );
				}
				return $entry;
			}
		);
	}

	/**
	 * The entry in a list that the same request made before its answer was lost.
	 */
	private static function sent_before( array $list, WP_REST_Request $request ) {
		$id = self::request_id( $request );
		foreach ( $list as $done ) {
			if ( '' !== $id && ( $done['request_id'] ?? '' ) === $id ) {
				return $done;
			}
		}
		return null;
	}

	private static function request_id( WP_REST_Request $request ) {
		return is_string( $request['request_id'] ) ? sanitize_key( $request['request_id'] ) : '';
	}

	private static function day_option( $list, $day ) {
		return 'shoptill_' . $list . '_' . $day;
	}

	private static function each_order( array $args ) {
		foreach ( self::pages( $args ) as $orders ) {
			yield from $orders;
		}
	}

	/**
	 * Yields the orders a query matches a page at a time, so a busy day fits in memory.
	 */
	private static function pages( array $args ) {
		$args = array_merge(
			$args,
			array(
				'limit'   => 100,
				'orderby' => 'ID',
				'order'   => 'ASC',
			)
		);
		for ( $page = 1; ; ++$page ) {
			$args['paged'] = $page;
			$orders        = wc_get_orders( $args );
			yield $orders;
			if ( count( $orders ) < $args['limit'] ) {
				return;
			}
			// WordPress holds on to every row it has read for the rest of the request.
			if ( wp_cache_supports( 'flush_runtime' ) ) {
				wp_cache_flush_runtime();
			}
		}
	}

	private static function rounded( array $rows, array $keys, $decimals ) {
		foreach ( $rows as &$row ) {
			foreach ( $keys as $key ) {
				$row[ $key ] = round( $row[ $key ], $decimals );
			}
		}
		unset( $row );
		return array_values( $rows );
	}

	private static function on_register( $order, $register_id ) {
		if ( '' === $register_id ) {
			return true;
		}
		$register = $order->get_meta( Orders::META_REGISTER );
		return is_array( $register ) && isset( $register['id'] ) && $register['id'] === $register_id;
	}

	private static function add( array &$by_method, $method, $label, $sales, $refunds ) {
		if ( ! isset( $by_method[ $method ] ) ) {
			$by_method[ $method ] = array(
				'method'  => $method,
				'label'   => $label,
				'sales'   => 0.0,
				'refunds' => 0.0,
			);
		}
		$by_method[ $method ]['sales']   += $sales;
		$by_method[ $method ]['refunds'] += $refunds;
	}
}
