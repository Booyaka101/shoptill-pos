<?php
namespace ShopTill;

defined( 'ABSPATH' ) || exit;

/**
 * The "POS" tab under WooCommerce > Settings, plus typed getters the REST layer reads.
 */
final class Settings {

	const TAB = 'shoptill';

	const DEFAULT_METHODS = array( 'cash', 'card' );

	public static function init() {
		add_filter( 'woocommerce_settings_tabs_array', array( __CLASS__, 'add_tab' ), 50 );
		add_action( 'woocommerce_sections_' . self::TAB, array( __CLASS__, 'output_sections' ) );
		add_action( 'woocommerce_settings_' . self::TAB, array( __CLASS__, 'output' ) );
		add_action( 'woocommerce_update_options_' . self::TAB, array( __CLASS__, 'save' ) );
		add_action( 'woocommerce_admin_field_shoptill_registers', array( __CLASS__, 'output_registers_field' ) );
		add_filter( 'woocommerce_admin_settings_sanitize_option_shoptill_registers', array( __CLASS__, 'sanitize_registers' ) );
	}

	public static function add_tab( $tabs ) {
		$tabs[ self::TAB ] = __( 'ShopTill', 'shoptill' );
		return $tabs;
	}

	private static function sections() {
		return array(
			''          => __( 'General', 'shoptill' ),
			'receipt'   => __( 'Receipts', 'shoptill' ),
			'registers' => __( 'Registers', 'shoptill' ),
		);
	}

	private static function current_section() {
		$section = isset( $_GET['section'] ) ? sanitize_key( wp_unslash( $_GET['section'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		return array_key_exists( $section, self::sections() ) ? $section : '';
	}

	public static function output_sections() {
		$current = self::current_section();
		$links   = array();
		foreach ( self::sections() as $id => $label ) {
			$url     = admin_url( 'admin.php?page=wc-settings&tab=' . self::TAB . '&section=' . $id );
			$links[] = sprintf( '<a href="%s" class="%s">%s</a>', esc_url( $url ), $current === $id ? 'current' : '', esc_html( $label ) );
		}
		echo '<ul class="subsubsub"><li>' . implode( ' | </li><li>', $links ) . '</li></ul><br class="clear" />'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	public static function output() {
		if ( '' === self::current_section() ) {
			printf(
				'<p>%s <a href="%s" target="_blank">%s</a></p>',
				esc_html__( 'Open the till at', 'shoptill' ),
				esc_url( App::url() ),
				esc_html( App::url() )
			);
			if ( App::plain_permalinks() ) {
				printf(
					'<p>%s</p>',
					esc_html__( 'The shop uses plain permalinks, so the till lives on that address rather than /pos/. Switching to pretty permalinks gives it the shorter one.', 'shoptill' )
				);
			}
		}
		woocommerce_admin_fields( self::fields( self::current_section() ) );
	}

	public static function save() {
		woocommerce_update_options( self::fields( self::current_section() ) );
	}

	private static function fields( $section ) {
		if ( 'receipt' === $section ) {
			return array(
				array(
					'title' => __( 'Receipts', 'shoptill' ),
					'type'  => 'title',
					'id'    => 'shoptill_receipt',
				),
				array(
					'title' => __( 'Logo URL', 'shoptill' ),
					'id'    => 'shoptill_receipt_logo',
					'type'  => 'url',
					'css'   => 'min-width:400px',
				),
				array(
					'title' => __( 'Header', 'shoptill' ),
					'desc'  => __( 'Printed under the shop name. Address, opening hours, website.', 'shoptill' ),
					'id'    => 'shoptill_receipt_header',
					'type'  => 'textarea',
					'css'   => 'min-width:400px;height:80px',
				),
				array(
					'title' => __( 'Footer', 'shoptill' ),
					'desc'  => __( 'Returns policy, thank-you note.', 'shoptill' ),
					'id'    => 'shoptill_receipt_footer',
					'type'  => 'textarea',
					'css'   => 'min-width:400px;height:80px',
				),
				array(
					'title' => __( 'Phone', 'shoptill' ),
					'id'    => 'shoptill_store_phone',
					'type'  => 'text',
				),
				array(
					'title' => __( 'Tax number', 'shoptill' ),
					'desc'  => __( 'VAT, GST or ABN number shown on receipts.', 'shoptill' ),
					'id'    => 'shoptill_tax_number',
					'type'  => 'text',
				),
				array(
					'title'   => __( 'Show SKU', 'shoptill' ),
					'id'      => 'shoptill_receipt_show_sku',
					'type'    => 'checkbox',
					'default' => 'no',
				),
				array(
					'title'   => __( 'Paper width', 'shoptill' ),
					'id'      => 'shoptill_receipt_width',
					'type'    => 'select',
					'default' => '80',
					'options' => array(
						'80' => '80 mm',
						'58' => '58 mm',
						'a4' => 'A4 / Letter',
					),
				),
				array(
					'type' => 'sectionend',
					'id'   => 'shoptill_receipt',
				),
			);
		}

		if ( 'registers' === $section ) {
			return array(
				array(
					'title' => __( 'Registers', 'shoptill' ),
					'desc'  => __( 'Each till that sells through the POS. Orders are tagged with the register and outlet they were taken on.', 'shoptill' ),
					'type'  => 'title',
					'id'    => 'shoptill_registers_title',
				),
				array(
					'id'   => 'shoptill_registers',
					'type' => 'shoptill_registers',
				),
				array(
					'type' => 'sectionend',
					'id'   => 'shoptill_registers_title',
				),
			);
		}

		$fields = array(
			array(
				'title' => __( 'Orders', 'shoptill' ),
				'type'  => 'title',
				'id'    => 'shoptill_orders',
			),
			array(
				'title'   => __( 'Status for POS sales', 'shoptill' ),
				'id'      => 'shoptill_order_status',
				'type'    => 'select',
				'default' => 'completed',
				'options' => array(
					'completed'  => __( 'Completed', 'shoptill' ),
					'processing' => __( 'Processing', 'shoptill' ),
				),
			),
			array(
				'title'   => __( 'Customer emails', 'shoptill' ),
				'desc'    => __( 'Send WooCommerce order emails to customers for POS sales. Receipts can still be emailed from the till.', 'shoptill' ),
				'id'      => 'shoptill_email_customer',
				'type'    => 'checkbox',
				'default' => 'no',
			),
			array(
				'title'   => __( 'Admin new-order emails', 'shoptill' ),
				'desc'    => __( 'Send the "New order" admin email for POS sales.', 'shoptill' ),
				'id'      => 'shoptill_email_admin',
				'type'    => 'checkbox',
				'default' => 'no',
			),
			array(
				'title'   => __( 'Sell out-of-stock items', 'shoptill' ),
				'desc'    => __( 'Let the till sell products with no stock left. Stock goes negative.', 'shoptill' ),
				'id'      => 'shoptill_allow_oversell',
				'type'    => 'checkbox',
				'default' => 'yes',
			),
			array(
				'title'   => __( 'Pay later', 'shoptill' ),
				'desc'    => __( 'Let the till put a sale on a customer\'s account. The order stays on hold until it is paid off at the till.', 'shoptill' ),
				'id'      => 'shoptill_pay_later',
				'type'    => 'checkbox',
				'default' => 'no',
			),
			array(
				'title'   => __( 'Cashier refunds', 'shoptill' ),
				'desc'    => __( 'Let every till user give refunds, not only administrators and shop managers.', 'shoptill' ),
				'id'      => 'shoptill_cashier_refunds',
				'type'    => 'checkbox',
				'default' => 'no',
			),
		array(
			'title'   => __( 'Ask for tips', 'shoptill' ),
			'desc'    => __( 'Offer a tip on the charge screen as preset percentages. The tip goes on the order as a fee and into the day\'s takings.', 'shoptill' ),
			'id'      => 'shoptill_tips',
			'type'    => 'checkbox',
			'default' => 'no',
		),
		array(
			'title'   => __( 'Cashiers may change prices', 'shoptill' ),
			'desc'    => __( 'Let accounts that cannot edit products change an item\'s price or discount it at the till.', 'shoptill' ),
			'id'      => 'shoptill_cashier_prices',
			'type'    => 'checkbox',
			'default' => 'no',
		),
			array(
				'type' => 'sectionend',
				'id'   => 'shoptill_orders',
			),
			array(
				'title' => __( 'Payment methods', 'shoptill' ),
				'type'  => 'title',
				'id'    => 'shoptill_payments',
			),
		);

		foreach ( self::method_labels() as $key => $label ) {
			$fields[] = array(
				'title'   => $label,
				'desc'    => __( 'Enabled', 'shoptill' ),
				'id'      => 'shoptill_pm_' . $key,
				'type'    => 'checkbox',
				'default' => in_array( $key, self::DEFAULT_METHODS, true ) ? 'yes' : 'no',
			);
		}
		$fields[] = array(
			'title'   => __( 'Label for "Other"', 'shoptill' ),
			'id'      => 'shoptill_pm_other_label',
			'type'    => 'text',
			'default' => __( 'Other', 'shoptill' ),
		);
		$fields[] = array(
			'type' => 'sectionend',
			'id'   => 'shoptill_payments',
		);

		return $fields;
	}

	public static function output_registers_field() {
		$registers = self::registers();
		$blank     = array(
			'id'     => '',
			'name'   => '',
			'outlet' => '',
		);
		?>
		<tr><td colspan="2" style="padding-left:0">
			<table class="widefat striped" style="max-width:700px">
				<thead><tr>
					<th><?php esc_html_e( 'Register name', 'shoptill' ); ?></th>
					<th><?php esc_html_e( 'Outlet', 'shoptill' ); ?></th>
					<th><?php esc_html_e( 'ID', 'shoptill' ); ?></th>
				</tr></thead>
				<tbody>
				<?php foreach ( array_merge( $registers, array( $blank ) ) as $i => $register ) : ?>
					<tr>
						<td><input type="text" name="shoptill_registers[<?php echo (int) $i; ?>][name]" value="<?php echo esc_attr( $register['name'] ); ?>" placeholder="<?php esc_attr_e( 'Add a register…', 'shoptill' ); ?>" /></td>
						<td><input type="text" name="shoptill_registers[<?php echo (int) $i; ?>][outlet]" value="<?php echo esc_attr( $register['outlet'] ); ?>" /></td>
						<td>
							<code><?php echo esc_html( $register['id'] ); ?></code>
							<input type="hidden" name="shoptill_registers[<?php echo (int) $i; ?>][id]" value="<?php echo esc_attr( $register['id'] ); ?>" />
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
			<p class="description"><?php esc_html_e( 'Clear a name to remove that register. Past orders keep the register name they were taken on.', 'shoptill' ); ?></p>
		</td></tr>
		<?php
	}

	public static function sanitize_registers( $value ) {
		$clean = array();
		foreach ( (array) $value as $row ) {
			$name = isset( $row['name'] ) ? sanitize_text_field( $row['name'] ) : '';
			if ( '' === $name ) {
				continue;
			}
			$id      = isset( $row['id'] ) ? sanitize_key( $row['id'] ) : '';
			$clean[] = array(
				'id'     => $id ? $id : 'reg-' . strtolower( wp_generate_password( 6, false ) ),
				'name'   => $name,
				'outlet' => isset( $row['outlet'] ) ? sanitize_text_field( $row['outlet'] ) : '',
			);
		}
		return $clean;
	}

	/**
	 * @return array<int, array{id: string, name: string, outlet: string}>
	 */
	public static function registers() {
		$registers = get_option( 'shoptill_registers' );
		if ( ! is_array( $registers ) || ! $registers ) {
			$registers = array(
				array(
					'id'     => 'main',
					'name'   => __( 'Main register', 'shoptill' ),
					'outlet' => App::shop_name(),
				),
			);
		}
		return $registers;
	}

	public static function register( $id ) {
		foreach ( self::registers() as $register ) {
			if ( $register['id'] === $id ) {
				return $register;
			}
		}
		return null;
	}

	/**
	 * @return array<string, string> Every payment method the till knows, keys mapped to their labels.
	 */
	public static function method_labels() {
		return array(
			'cash'   => __( 'Cash', 'shoptill' ),
			'card'   => __( 'Card', 'shoptill' ),
			'bank'   => __( 'Bank transfer', 'shoptill' ),
			'cheque' => __( 'Cheque', 'shoptill' ),
			'other'  => __( 'Other', 'shoptill' ),
		);
	}

	/**
	 * @return array<string, string> Enabled payment method keys mapped to their labels.
	 */
	public static function payment_methods() {
		$methods = array();
		foreach ( self::method_labels() as $key => $label ) {
			$default = in_array( $key, self::DEFAULT_METHODS, true ) ? 'yes' : 'no';
			if ( 'yes' === get_option( 'shoptill_pm_' . $key, $default ) ) {
				$methods[ $key ] = 'other' === $key && '' !== trim( self::text( 'shoptill_pm_other_label' ) ) ? self::text( 'shoptill_pm_other_label' ) : $label;
			}
		}
		return $methods;
	}

	public static function order_status() {
		$status = get_option( 'shoptill_order_status', 'completed' );
		return in_array( $status, array( 'completed', 'processing' ), true ) ? $status : 'completed';
	}

	public static function flag( $name, $default = 'no' ) {
		return 'yes' === get_option( 'shoptill_' . $name, $default );
	}

	/**
	 * A text setting as plain text. WooCommerce saves them HTML-encoded, and the till prints them as text.
	 */
	private static function text( $option, $default = '' ) {
		return html_entity_decode( (string) get_option( $option, $default ), ENT_QUOTES | ENT_HTML5, 'UTF-8' );
	}

	public static function receipt() {
		$base = WC()->countries;
		return array(
			'store_name' => App::shop_name(),
			// Laid out the way the shop's country writes addresses, which leaves the country itself out.
			'address'    => array_values(
				array_filter(
					array_map(
						static function ( $line ) {
							return trim( html_entity_decode( $line, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
						},
						explode(
							'<br/>',
							$base->get_formatted_address(
								array(
									'address_1' => $base->get_base_address(),
									'address_2' => $base->get_base_address_2(),
									'city'      => $base->get_base_city(),
									'state'     => $base->get_base_state(),
									'postcode'  => $base->get_base_postcode(),
									'country'   => $base->get_base_country(),
								)
							)
						)
					)
				)
			),
			'logo'       => get_option( 'shoptill_receipt_logo', '' ),
			'header'     => self::text( 'shoptill_receipt_header' ),
			'footer'     => self::text( 'shoptill_receipt_footer' ),
			'phone'      => self::text( 'shoptill_store_phone' ),
			'tax_number' => self::text( 'shoptill_tax_number' ),
			'show_sku'   => self::flag( 'receipt_show_sku' ),
			'width'      => get_option( 'shoptill_receipt_width', '80' ),
		);
	}
}
