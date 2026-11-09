<?php
namespace ShopTill;

use Automattic\WooCommerce\Utilities\OrderUtil;
use WC_Order;
use WC_Order_Refund;
use WP_Error;
use WP_REST_Request;
use WP_REST_Server;

defined( 'ABSPATH' ) || exit;

final class Rest {

	const NS = 'shoptill/v1';

	// Receipts a till may email in an hour, so a stolen token can't send the shop's mail to anyone.
	const MAIL_PER_USER  = 60;
	const MAIL_PER_ORDER = 5;

	const ADDRESS_FIELDS = array( 'address_1', 'address_2', 'city', 'postcode', 'state', 'country' );

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	public static function register_routes() {
		$can_use    = static function () {
			return current_user_can( Plugin::CAP_USE );
		};
		$can_refund = static function () {
			return current_user_can( Plugin::CAP_REFUND );
		};

		$routes = array(
			'/auth/login'              => array( WP_REST_Server::CREATABLE, array( Auth::class, 'login' ), '__return_true' ),
			'/auth/logout'             => array( WP_REST_Server::CREATABLE, array( Auth::class, 'logout' ), $can_use ),
			'/bootstrap'               => array( WP_REST_Server::READABLE, array( __CLASS__, 'bootstrap' ), $can_use ),
			'/products'                => array( WP_REST_Server::READABLE, array( __CLASS__, 'products' ), $can_use ),
			'/products/ids'            => array( WP_REST_Server::READABLE, array( Catalog::class, 'product_ids' ), $can_use ),
			'/products/(?P<id>\d+)'      => array(
				WP_REST_Server::CREATABLE,
				array( __CLASS__, 'update_product' ),
				static function ( WP_REST_Request $request ) {
					// Variations don't map edit_product to the stricter caps, so their parent is checked.
					$product = wc_get_product( (int) $request['id'] );
					$id      = $product && $product->get_parent_id() ? $product->get_parent_id() : (int) $request['id'];
					return current_user_can( Plugin::CAP_USE ) && current_user_can( 'edit_product', $id );
				},
			),
			'/stock'                   => array( WP_REST_Server::READABLE, array( Catalog::class, 'stock' ), $can_use ),
			'/customers'               => array(
				array( WP_REST_Server::READABLE, array( __CLASS__, 'customers' ), $can_use ),
				array( WP_REST_Server::CREATABLE, array( __CLASS__, 'create_customer' ), $can_use ),
			),
			'/customers/(?P<id>\d+)'     => array(
				array( WP_REST_Server::READABLE, array( __CLASS__, 'customer_profile' ), $can_use ),
				array( WP_REST_Server::CREATABLE, array( __CLASS__, 'update_customer' ), $can_use ),
			),
			'/orders/preview'          => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'preview_order' ), $can_use ),
			'/orders'                  => array(
				array( WP_REST_Server::READABLE, array( __CLASS__, 'orders' ), $can_use ),
				array( WP_REST_Server::CREATABLE, array( __CLASS__, 'create_order' ), $can_use ),
			),
			'/orders/(?P<id>\d+)'        => array( WP_REST_Server::READABLE, array( __CLASS__, 'order' ), $can_use ),
			'/orders/(?P<id>\d+)/refund' => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'refund_order' ), $can_refund ),
			'/orders/(?P<id>\d+)/email'  => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'email_receipt' ), $can_use ),
			'/orders/(?P<id>\d+)/pay'    => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'pay_order' ), $can_use ),
			// A cashier only finds till sales, and of those only one handed over later can change status.
			'/orders/(?P<id>\d+)/status' => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'order_status' ), $can_use ),
			'/orders/(?P<id>\d+)/note'   => array( WP_REST_Server::CREATABLE, array( __CLASS__, 'order_note' ), $can_use ),
			'/reports/summary'         => array( WP_REST_Server::READABLE, array( Reports::class, 'summary' ), $can_use ),
			'/reports/close'           => array( WP_REST_Server::CREATABLE, array( Reports::class, 'close' ), $can_use ),
			'/reports/cash'            => array( WP_REST_Server::CREATABLE, array( Reports::class, 'move_cash' ), $can_use ),
		);

		foreach ( $routes as $path => $handlers ) {
			$handlers = is_array( $handlers[0] ) ? $handlers : array( $handlers );
			register_rest_route(
				self::NS,
				$path,
				array_map(
					static function ( $h ) {
						return array(
							'methods'             => $h[0],
							'callback'            => $h[1],
							'permission_callback' => $h[2],
						);
					},
					$handlers
				)
			);
		}
	}

	public static function bootstrap() {
		return array(
			'user'            => Auth::user_payload( wp_get_current_user() ),
			'store'           => Settings::receipt(),
			'registers'       => Settings::registers(),
			'payment_methods' => Settings::payment_methods(),
			'allow_oversell'  => Settings::flag( 'allow_oversell', 'yes' ),
			'pay_later'       => Settings::flag( 'pay_later' ),
		'may_change_prices' => current_user_can( 'edit_products' ) || Settings::flag( 'cashier_prices' ),
		'tips'             => Settings::flag( 'tips' ),
			'tax'             => Catalog::tax_config(),
			'countries'       => array_map( 'html_entity_decode', WC()->countries->get_allowed_countries() ),
			'ship_countries'  => array_keys( WC()->countries->get_shipping_countries() ),
			'base_country'    => WC()->countries->get_base_country(),
			'categories'      => Catalog::categories(),
			'currency'        => array(
				'code'               => get_woocommerce_currency(),
				'symbol'             => html_entity_decode( get_woocommerce_currency_symbol() ),
				'position'           => get_option( 'woocommerce_currency_pos', 'left' ),
				'decimals'           => wc_get_price_decimals(),
				'decimal_separator'  => html_entity_decode( wc_get_price_decimal_separator() ),
				'thousand_separator' => html_entity_decode( wc_get_price_thousand_separator() ),
			),
			'server_time'     => time(),
			'version'         => SHOPTILL_VERSION,
			'utc_offset'      => wp_timezone()->getOffset( new \DateTime() ),
			'timezone'        => wp_timezone()->getName(),
			// Whether a cost-of-goods plugin is active, so the till knows to offer costs to staff.
			'cogs'            => Costs::active(),
		);
	}

	public static function products( WP_REST_Request $request ) {
		$page           = max( 1, (int) $request['page'] );
		$per_page       = min( 250, max( 1, (int) ( $request['per_page'] ? $request['per_page'] : 100 ) ) );
		$modified_after = $request['modified_after'] ? (int) $request['modified_after'] : null;
		$after          = null === $request['after'] ? null : max( 0, (int) $request['after'] );
		return Catalog::products( $page, $per_page, $modified_after, $after );
	}

	public static function update_product( WP_REST_Request $request ) {
		$product = wc_get_product( (int) $request['id'] );
		if ( ! $product || ! $product->is_type( array( 'simple', 'variation' ) ) || ! Catalog::is_sellable( $product ) ) {
			return new WP_Error( 'shoptill_product', __( 'Product not found.', 'shoptill' ), array( 'status' => 404 ) );
		}
		return Catalog::update( $product, (array) $request->get_json_params() );
	}

	public static function customers( WP_REST_Request $request ) {
		$search = trim( Plugin::text( $request['search'] ) );
		if ( strlen( $search ) < 2 ) {
			return array();
		}
		$scope = current_user_can( 'list_users' ) ? array() : array( 'role__in' => self::customer_roles() );
		$query = new \WP_User_Query(
			$scope + array(
				'search'         => '*' . $search . '*',
				'search_columns' => array( 'user_login', 'user_email', 'display_name' ),
				'number'         => 20,
				'fields'         => 'ID',
			)
		);
		$ids   = $query->get_results();

		// Names and phone numbers live in user meta, which WP_User_Query search does not cover.
		if ( count( $ids ) < 20 ) {
			$meta = array( 'relation' => 'OR' );
			foreach ( preg_match( '/\d{3,}/', $search ) ? array( 'billing_phone' ) : array( 'first_name', 'last_name' ) as $key ) {
				$meta[] = array(
					'key'     => $key,
					'value'   => $search,
					'compare' => 'LIKE',
				);
			}
			$words = preg_split( '/\s+/', $search, 2 );
			if ( 2 === count( $words ) ) {
				$meta[] = array(
					array(
						'key'     => 'first_name',
						'value'   => $words[0],
						'compare' => 'LIKE',
					),
					array(
						'key'     => 'last_name',
						'value'   => $words[1],
						'compare' => 'LIKE',
					),
				);
			}
			$by_meta = get_users(
				$scope + array(
					'meta_query' => $meta, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					'number'     => 20,
					'fields'     => 'ID',
				)
			);
			$ids     = array_slice( array_unique( array_merge( $ids, $by_meta ) ), 0, 20 );
		}

		return array_values( array_map( array( __CLASS__, 'customer' ), $ids ) );
	}

	public static function create_customer( WP_REST_Request $request ) {
		$fields = self::customer_input( $request );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}
		$email = $fields['email'] ?? '';
		if ( ! is_email( $email ) ) {
			return new WP_Error( 'shoptill_email', __( 'A valid email address is required.', 'shoptill' ), array( 'status' => 422 ) );
		}
		// WordPress checks the email is free and then inserts, so two tills adding one walk-in would make two accounts.
		return Orders::locked(
			self::email_lock( $email ),
			function () use ( $email, $fields ) {
				$existing = get_user_by( 'email', $email );
				if ( $existing ) {
					if ( ! self::is_customer( $existing->ID ) ) {
						return new WP_Error( 'shoptill_email', __( 'That email address cannot be used for a customer.', 'shoptill' ), array( 'status' => 422 ) );
					}
					return self::customer( $existing->ID );
				}

				$first    = $fields['first_name'] ?? '';
				$last     = $fields['last_name'] ?? '';
				$customer = new \WC_Customer();
				$customer->set_username( wc_create_new_customer_username( $email, array( 'first_name' => $first, 'last_name' => $last ) ) );
				$customer->set_password( wp_generate_password() );
				// Left on for the rest of the request, since the shop may send its emails at shutdown.
				add_filter( 'woocommerce_email_enabled_customer_new_account', '__return_false' );
				return self::save_customer( $customer, $fields );
			}
		);
	}

	public static function customer_profile( WP_REST_Request $request ) {
		$id = (int) $request['id'];
		if ( ! self::only_customer( get_userdata( $id ) ) ) {
			return new WP_Error( 'shoptill_customer', __( 'Customer not found.', 'shoptill' ), array( 'status' => 404 ) );
		}
		$customer = new \WC_Customer( $id );
		return self::customer( $id ) + array(
			'order_count' => (int) $customer->get_order_count(),
			'total_spent' => (float) $customer->get_total_spent(),
		);
	}

	public static function update_customer( WP_REST_Request $request ) {
		$id   = (int) $request['id'];
		$user = get_userdata( $id );
		if ( ! self::only_customer( $user ) ) {
			return new WP_Error( 'shoptill_customer', __( 'Customer not found.', 'shoptill' ), array( 'status' => 404 ) );
		}
		$fields = self::customer_input( $request );
		if ( is_wp_error( $fields ) ) {
			return $fields;
		}
		$save = function () use ( $request, $id, $fields ) {
			$saved = self::save_customer( new \WC_Customer( $id ), $fields );
			return is_wp_error( $saved ) ? $saved : self::customer_profile( $request );
		};
		if ( ! isset( $fields['email'] ) || 0 === strcasecmp( $fields['email'], $user->user_email ) ) {
			unset( $fields['email'] );
			return $save();
		}
		if ( ! is_email( $fields['email'] ) ) {
			return new WP_Error( 'shoptill_email', __( 'That email address is not valid.', 'shoptill' ), array( 'status' => 422 ) );
		}
		// Password resets go to the account's email, so moving it is moving the account.
		if ( ! current_user_can( 'edit_user', $id ) ) {
			return new WP_Error( 'shoptill_email', __( "Only staff who can edit users can change a customer's email.", 'shoptill' ), array( 'status' => 403 ) );
		}
		return Orders::locked(
			self::email_lock( $fields['email'] ),
			function () use ( $fields, $save ) {
				if ( get_user_by( 'email', $fields['email'] ) ) {
					return new WP_Error( 'shoptill_email', __( 'Another account already uses that email address.', 'shoptill' ), array( 'status' => 409 ) );
				}
				return $save();
			}
		);
	}

	private static function email_lock( $email ) {
		return 'shoptill_customer_' . md5( strtolower( $email ) );
	}

	/**
	 * The customer details a request sets, cleaned. A field left out of the request is left as it is.
	 */
	private static function customer_input( WP_REST_Request $request ) {
		$fields = array();
		foreach ( array( 'email', 'first_name', 'last_name', 'phone' ) as $key ) {
			if ( null !== $request[ $key ] ) {
				$fields[ $key ] = sanitize_text_field( Plugin::text( $request[ $key ] ) );
			}
		}
		if ( isset( $fields['email'] ) ) {
			$fields['email'] = sanitize_email( $fields['email'] );
		}
		if ( isset( $fields['phone'] ) ) {
			$fields['phone'] = wc_sanitize_phone_number( $fields['phone'] );
		}
		if ( is_array( $request['address'] ) ) {
			$fields['address'] = self::address_input( $request['address'] );
			if ( '' !== $fields['address']['country'] && ! isset( WC()->countries->get_allowed_countries()[ $fields['address']['country'] ] ) ) {
				return new WP_Error( 'shoptill_country', __( "The shop doesn't sell to that country.", 'shoptill' ), array( 'status' => 422 ) );
			}
		}
		return $fields;
	}

	/**
	 * An address from the till, with every field present.
	 */
	public static function address_input( array $address ) {
		$clean = array();
		foreach ( self::ADDRESS_FIELDS as $key ) {
			$clean[ $key ] = sanitize_text_field( Plugin::text( $address[ $key ] ?? '' ) );
		}
		$clean['country'] = strtoupper( $clean['country'] );
		return $clean;
	}

	private static function save_customer( \WC_Customer $customer, array $fields ) {
		$made = array( trim( $customer->get_first_name() . ' ' . $customer->get_last_name() ), $customer->get_email() );
		foreach ( array( 'first_name', 'last_name' ) as $key ) {
			if ( isset( $fields[ $key ] ) ) {
				$customer->{"set_$key"}( $fields[ $key ] );
				$customer->{"set_billing_$key"}( $fields[ $key ] );
			}
		}
		if ( isset( $fields['email'] ) ) {
			$customer->set_email( $fields['email'] );
			$customer->set_billing_email( $fields['email'] );
		}
		if ( isset( $fields['phone'] ) ) {
			$customer->set_billing_phone( $fields['phone'] );
		}
		foreach ( $fields['address'] ?? array() as $key => $value ) {
			$customer->{"set_billing_$key"}( $value );
		}
		// Only a display name the till made, so one the customer chose is kept.
		if ( ! $customer->get_id() || in_array( $customer->get_display_name(), $made, true ) ) {
			$name = trim( $customer->get_first_name() . ' ' . $customer->get_last_name() );
			$customer->set_display_name( $name ? $name : $customer->get_email() );
		}
		try {
			$customer->save();
		} catch ( \WC_Data_Exception $e ) {
			return new WP_Error( 'shoptill_customer', $e->getMessage(), array( 'status' => 409 ) );
		}
		return self::customer( $customer->get_id() );
	}

	private static function customer_roles() {
		return apply_filters( 'shoptill_customer_roles', array( 'customer', 'subscriber' ) );
	}

	/**
	 * An account with no role but a customer's, so the till never shows or edits a colleague's details.
	 */
	private static function only_customer( $user ) {
		return $user && $user->roles && ! array_diff( (array) $user->roles, self::customer_roles() );
	}

	/**
	 * Cashiers only see and sell to customer accounts, not staff. Managers who can list users see everyone.
	 */
	public static function is_customer( $user_id ) {
		if ( current_user_can( 'list_users' ) ) {
			return true;
		}
		$user = get_userdata( $user_id );
		return $user && array_intersect( (array) $user->roles, self::customer_roles() );
	}

	/**
	 * Cashiers work with till sales only. Staff who can manage WooCommerce orders see every order.
	 */
	private static function can_see( WC_Order $order ) {
		// A trashed order is on its way out, and the reports no longer count it.
		return ! $order->has_status( 'trash' ) && ( Plugin::is_pos_order( $order ) || current_user_can( 'edit_shop_orders' ) );
	}

	private static function find_order( $id ) {
		$order = wc_get_order( (int) $id );
		if ( ! $order instanceof WC_Order || ! self::can_see( $order ) ) {
			return new WP_Error( 'shoptill_not_found', __( 'Order not found.', 'shoptill' ), array( 'status' => 404 ) );
		}
		return $order;
	}

	private static function customer( $id ) {
		$c = new \WC_Customer( $id );
		return array(
			'id'         => $c->get_id(),
			'first_name' => $c->get_first_name() ? $c->get_first_name() : $c->get_billing_first_name(),
			'last_name'  => $c->get_last_name() ? $c->get_last_name() : $c->get_billing_last_name(),
			'email'      => $c->get_email(),
			'phone'      => $c->get_billing_phone(),
			'address'    => array_combine(
				self::ADDRESS_FIELDS,
				array_map(
					static function ( $key ) use ( $c ) {
						return $c->{"get_billing_$key"}();
					},
					self::ADDRESS_FIELDS
				)
			),
		);
	}

	public static function preview_order( WP_REST_Request $request ) {
		return Orders::preview( (array) $request->get_json_params() );
	}

	public static function create_order( WP_REST_Request $request ) {
		$order = Orders::create( (array) $request->get_json_params() );
		return is_wp_error( $order ) ? $order : self::order_payload( $order );
	}

	public static function orders( WP_REST_Request $request ) {
		$args = array(
			'limit'    => 25,
			'page'     => max( 1, (int) $request['page'] ),
			'paginate' => true,
			'orderby'  => 'date ID',
			'order'    => 'DESC',
			'type'     => 'shop_order',
		);
		$hpos  = OrderUtil::custom_orders_table_usage_is_enabled();
		$meta  = array();
		$later = 'later' === $request['source'];
		if ( 'pos' === $request['source'] || $later || ! current_user_can( 'edit_shop_orders' ) ) {
			$args['created_via'] = Plugin::SOURCE;
			if ( $later ) {
				$meta[] = array(
					'key'     => Orders::META_FULFIL,
					'compare' => 'EXISTS',
				);
			}
		} elseif ( 'web' === $request['source'] ) {
			$made = $hpos ? array( 'field' => 'created_via' ) : array( 'key' => '_created_via' );
			// Orders a plugin made without saying where come from the web too.
			$not_pos = array(
				'relation' => 'OR',
				$made + array(
					'value'   => Plugin::SOURCE,
					'compare' => '!=',
				),
				$made + array( 'compare' => 'NOT EXISTS' ),
			);
			if ( $hpos ) {
				$args['field_query'] = $not_pos;
			} else {
				$meta[] = $not_pos;
			}
		}
		if ( $meta && $hpos ) {
			$args['meta_query'] = $meta; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		} elseif ( $meta ) {
			// The legacy order store drops a meta_query passed to wc_get_orders().
			$legacy = static function ( $query ) use ( $meta ) {
				foreach ( $meta as $clause ) {
					$query['meta_query'][] = $clause;
				}
				return $query;
			};
		}
		$customer = max( 0, (int) $request['customer_id'] );
		if ( $customer ) {
			$args['customer_id'] = $customer;
		}
		$status = preg_replace( '/^wc-/', '', Plugin::text( $request['status'] ) );
		if ( isset( wc_get_order_statuses()[ 'wc-' . $status ] ) ) {
			$args['status'] = array( $status );
		}
		$search = trim( Plugin::text( $request['search'] ) );
		if ( '' !== $search ) {
			$order = ctype_digit( ltrim( $search, '#' ) ) ? wc_get_order( (int) ltrim( $search, '#' ) ) : null;
			$fits  = $order instanceof WC_Order && self::can_see( $order )
				&& ( isset( $args['created_via'] ) ? Plugin::is_pos_order( $order ) : ! isset( $not_pos ) || ! Plugin::is_pos_order( $order ) )
				&& ( ! isset( $args['status'] ) || $order->has_status( $args['status'] ) )
				&& ( ! $customer || $order->get_customer_id() === $customer )
				&& ( ! $later || $order->get_meta( Orders::META_FULFIL ) );
			if ( $fits ) {
				$orders = array( $order );
				$pages  = 1;
			} elseif ( OrderUtil::custom_orders_table_usage_is_enabled() ) {
				// Not an order number, so perhaps a phone number. On this store wc_order_search() stops at ten matches.
				$args['s'] = $search;
			} else {
				// The legacy order store ignores an 's' query arg.
				$ids              = wc_order_search( $search );
				$args['post__in'] = $ids ? $ids : array( 0 );
			}
		}
		if ( ! isset( $orders ) ) {
			if ( isset( $legacy ) ) {
				add_filter( 'woocommerce_order_data_store_cpt_get_orders_query', $legacy );
			}
			try {
				$result = wc_get_orders( $args );
			} finally {
				if ( isset( $legacy ) ) {
					remove_filter( 'woocommerce_order_data_store_cpt_get_orders_query', $legacy );
				}
			}
			$orders = $result->orders;
			$pages  = $result->max_num_pages;
		}
		return array(
			'orders'      => array_map( array( __CLASS__, 'order_summary' ), $orders ),
			'total'       => isset( $result ) ? (int) $result->total : count( $orders ),
			'total_pages' => (int) $pages,
		);
	}

	public static function order( WP_REST_Request $request ) {
		$order = self::find_order( $request['id'] );
		return is_wp_error( $order ) ? $order : self::order_payload( $order );
	}

	public static function refund_order( WP_REST_Request $request ) {
		return self::change_order( $request, array( Orders::class, 'refund' ) );
	}

	public static function pay_order( WP_REST_Request $request ) {
		return self::change_order( $request, array( Orders::class, 'take_payment' ) );
	}

	public static function order_status( WP_REST_Request $request ) {
		return self::change_order( $request, array( Orders::class, 'set_status' ) );
	}

	public static function order_note( WP_REST_Request $request ) {
		return self::change_order( $request, array( Orders::class, 'add_note' ) );
	}

	/**
	 * One till at a time changes an order, and the order is loaded only once the lock is held, so a refund
	 * or payment another till has just saved is counted.
	 */
	private static function change_order( WP_REST_Request $request, callable $change ) {
		return Orders::locked(
			'shoptill_order_' . (int) $request['id'],
			static function () use ( $request, $change ) {
				$order = self::find_order( $request['id'] );
				if ( is_wp_error( $order ) ) {
					return $order;
				}
				// A retry after a lost response carries the same request_id and gets the order as it now stands.
				$body = (array) $request->get_json_params();
				if ( Orders::request_done( $order, isset( $body['request_id'] ) ? sanitize_key( $body['request_id'] ) : '' ) ) {
					Orders::settle_if_cleared( $order );
					return self::order_payload( $order );
				}
				$result = $change( $order, $body );
				return is_wp_error( $result ) ? $result : self::order_payload( wc_get_order( $order->get_id() ) );
			}
		);
	}

	/**
	 * Counts an email the till sends a customer against the hour's limits, or says the limit is reached.
	 */
	public static function count_mail( WC_Order $order ) {
		// Counted under a lock, or sends made at once would all pass the check before any was counted.
		return Orders::locked(
			'shoptill_mail',
			static function () use ( $order ) {
				$hour   = intdiv( time(), HOUR_IN_SECONDS );
				$limits = array(
					'shoptill_mail_' . get_current_user_id() . '_' . $hour    => self::MAIL_PER_USER,
					'shoptill_mail_order_' . $order->get_id() . '_' . $hour => self::MAIL_PER_ORDER,
				);
				foreach ( $limits as $key => $max ) {
					if ( (int) get_transient( $key ) >= $max ) {
						return new WP_Error( 'shoptill_email_limit', __( 'That is as many emails as can be sent for now. Try again in an hour.', 'shoptill' ), array( 'status' => 429 ) );
					}
				}
				foreach ( $limits as $key => $max ) {
					set_transient( $key, (int) get_transient( $key ) + 1, HOUR_IN_SECONDS );
				}
				return true;
			}
		);
	}

	public static function email_receipt( WP_REST_Request $request ) {
		$order = self::find_order( $request['id'] );
		if ( is_wp_error( $order ) ) {
			return $order;
		}
		$raw   = trim( Plugin::text( $request['email'] ) );
		$email = sanitize_email( $raw );
		if ( '' !== $raw && ! is_email( $email ) ) {
			return new WP_Error( 'shoptill_email', __( 'That email address is not valid.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$to = $email ? $email : $order->get_billing_email();
		if ( ! $to ) {
			return new WP_Error( 'shoptill_email', __( 'This order has no email address.', 'shoptill' ), array( 'status' => 422 ) );
		}
		$counted = self::count_mail( $order );
		if ( is_wp_error( $counted ) ) {
			return $counted;
		}

		// Sent to the address given without replacing the one already on the order.
		$recipient = static function () use ( $to ) {
			return $to;
		};
		$sent      = false;
		$result    = static function ( $ok, $id ) use ( &$sent ) {
			$sent = $sent || ( $ok && 'customer_invoice' === $id );
		};
		add_filter( 'woocommerce_email_recipient_customer_invoice', $recipient, 99 );
		add_action( 'woocommerce_email_sent', $result, 10, 2 );
		Emails::sending_receipt( true );
		try {
			WC()->mailer()->emails['WC_Email_Customer_Invoice']->trigger( $order->get_id(), $order );
		} finally {
			Emails::sending_receipt( false );
			remove_action( 'woocommerce_email_sent', $result, 10 );
			remove_filter( 'woocommerce_email_recipient_customer_invoice', $recipient, 99 );
		}
		if ( ! $sent ) {
			return new WP_Error( 'shoptill_email_failed', __( 'The shop could not send the email. Check its mail settings in WordPress.', 'shoptill' ), array( 'status' => 502 ) );
		}
		if ( $email && ! $order->get_billing_email() ) {
			// A walk-in sale keeps the address it was sent to, so the order can be found by it later.
			$order->set_billing_email( $email );
			$order->save();
		}

		/* translators: %s: email address */
		$order->add_order_note( sprintf( __( 'Receipt emailed to %s from the till.', 'shoptill' ), $to ) );
		return array( 'ok' => true );
	}

	private static function order_summary( WC_Order $order ) {
		return array(
			'id'              => $order->get_id(),
			'number'          => $order->get_order_number(),
			'status'          => $order->get_status(),
			'date'            => $order->get_date_created() ? $order->get_date_created()->getTimestamp() : null,
			'total'           => (float) $order->get_total(),
			'refunded'        => (float) $order->get_total_refunded(),
			'customer'        => trim( $order->get_formatted_billing_full_name() ),
			'payment'         => $order->get_payment_method_title(),
			'pos'             => Plugin::is_pos_order( $order ),
			'client_id'       => $order->get_meta( Orders::META_CLIENT_ID ),
			'item_count'      => $order->get_item_count(),
			'shipping_method' => $order->get_shipping_method(),
			'fulfil'          => (string) $order->get_meta( Orders::META_FULFIL ),
		);
	}

	/**
	 * WooCommerce formats an address as HTML lines for the country's layout.
	 */
	private static function address_lines( $html ) {
		$lines = array_map(
			static function ( $line ) {
				return trim( html_entity_decode( wp_strip_all_tags( $line ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
			},
			preg_split( '/<br\s*\/?>/i', (string) $html )
		);
		return array_values( array_filter( $lines, 'strlen' ) );
	}

	public static function order_payload( WC_Order $order ) {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			/** @var \WC_Order_Item_Product $item */
			$product = $item->get_product();
			$taxes   = $item->get_taxes()['total'] ?? array();
			$items[] = array(
				'id'           => $item->get_id(),
				'product_id'   => $item->get_variation_id() ? $item->get_variation_id() : $item->get_product_id(),
				'name'         => $item->get_name(),
				'sku'          => $product ? $product->get_sku() : '',
				'qty'          => $item->get_quantity(),
				'qty_refunded' => -1 * $order->get_qty_refunded_for_item( $item->get_id() ),
				'subtotal'     => (float) $item->get_subtotal(),
				'subtotal_tax' => (float) $item->get_subtotal_tax(),
				'total'        => (float) $item->get_total(),
				'total_tax'    => (float) $item->get_total_tax(),
				'taxes'        => array_values( array_map( 'floatval', $taxes ) ),
				// What refunds took already, so the till can price the last units back the way the refund does.
				'refunded'     => (float) $order->get_total_refunded_for_item( $item->get_id() ),
				'tax_refunded' => array_map(
					static function ( $rate_id ) use ( $order, $item ) {
						return (float) $order->get_tax_refunded_for_item( $item->get_id(), $rate_id );
					},
					array_keys( $taxes )
				),
				'meta'         => array_values(
					array_map(
						static function ( $meta ) {
							return array(
								'key'   => wp_strip_all_tags( $meta->display_key ),
								'value' => html_entity_decode( wp_strip_all_tags( $meta->display_value ), ENT_QUOTES ),
							);
						},
						$item->get_formatted_meta_data()
					)
				),
			);
		}

		$taxes = array();
		foreach ( $order->get_tax_totals() as $tax ) {
			$taxes[] = array(
				'label'  => $tax->label,
				'amount' => (float) $tax->amount,
			);
		}

		$refunds = array_map(
			static function ( WC_Order_Refund $refund ) {
				return array(
					'id'     => $refund->get_id(),
					'amount' => (float) $refund->get_amount(),
					'reason' => $refund->get_reason(),
					'date'   => $refund->get_date_created() ? $refund->get_date_created()->getTimestamp() : null,
					'method' => $refund->get_meta( Orders::META_REFUND_BY ),
				);
			},
			$order->get_refunds()
		);

		$coupons = array();
		foreach ( $order->get_items( 'coupon' ) as $coupon ) {
			/** @var \WC_Order_Item_Coupon $coupon */
			$coupons[] = array(
				'code'     => $coupon->get_code(),
				'discount' => (float) $coupon->get_discount(),
			);
		}

		$register = $order->get_meta( Orders::META_REGISTER );
		$fees     = array();
		foreach ( $order->get_items( 'fee' ) as $fee ) {
			$fees[] = array(
				'name'      => $fee->get_name(),
				'total'     => (float) $fee->get_total(),
				'total_tax' => (float) $fee->get_total_tax(),
			);
		}
		$cashier  = (int) $order->get_meta( Orders::META_CASHIER );

		return array_merge(
			self::order_summary( $order ),
			array(
				'items'              => $items,
				'coupons'            => $coupons,
				'subtotal'           => (float) $order->get_subtotal(),
				'shipping_total'     => (float) $order->get_shipping_total(),
				'shipping_tax'       => (float) $order->get_shipping_tax(),
				'fees'               => $fees,
				'discount_total'     => (float) $order->get_discount_total(),
				'discount_tax'       => (float) $order->get_discount_tax(),
				'total_tax'          => (float) $order->get_total_tax(),
				'taxes'              => $taxes,
				'prices_include_tax' => $order->get_prices_include_tax(),
				'payments'           => Orders::payments( $order ),
				'refunds'            => $refunds,
				'remaining_refund'   => (float) $order->get_remaining_refund_amount(),
				'owed'               => Orders::owed( $order ),
				'email'              => $order->get_billing_email(),
				'phone'              => $order->get_billing_phone(),
				'billing_address'    => self::address_lines( $order->get_formatted_billing_address() ),
				'shipping_address'   => self::address_lines( $order->get_formatted_shipping_address() ),
				'note'               => $order->get_customer_note(),
				'notes'              => array_map(
					static function ( $note ) {
						return array(
							'id'       => (int) $note->id,
							'content'  => html_entity_decode( wp_strip_all_tags( $note->content ), ENT_QUOTES ),
							'customer' => (bool) $note->customer_note,
							'date'     => $note->date_created ? $note->date_created->getTimestamp() : null,
							'by'       => 'system' === $note->added_by ? '' : $note->added_by,
						);
					},
					wc_get_order_notes( array( 'order_id' => $order->get_id() ) )
				),
				'register'           => is_array( $register ) ? $register : null,
				'cashier'            => $cashier,
				'cashier_name'       => $cashier && get_userdata( $cashier ) ? get_userdata( $cashier )->display_name : '',
			)
		);
	}
}
