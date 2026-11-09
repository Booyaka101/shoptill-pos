<?php
/**
 * Removes ShopTill's settings, role, capabilities, till logins and the hidden-from-till flag on products.
 * Orders taken at the till are kept.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once __DIR__ . '/includes/class-plugin.php';
require_once __DIR__ . '/includes/class-auth.php';
require_once __DIR__ . '/includes/class-catalog.php';

global $wpdb;

// First, so a timeout further down can't leave logins behind with nothing confining them.
ShopTill\Auth::revoke_all();

$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE 'shoptill\_%' OR option_name LIKE '\_transient\_shoptill\_%' OR option_name LIKE '\_transient\_timeout\_shoptill\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery

delete_post_meta_by_key( ShopTill\Catalog::META_HIDDEN );

remove_role( 'shoptill_cashier' );
foreach ( wp_roles()->role_objects as $role ) {
	$role->remove_cap( ShopTill\Plugin::CAP_USE );
	$role->remove_cap( ShopTill\Plugin::CAP_REFUND );
}
// Capabilities granted to one user at a time live on the user, not their role.
foreach ( array( ShopTill\Plugin::CAP_USE, ShopTill\Plugin::CAP_REFUND ) as $cap ) {
	foreach ( get_users( array( 'capability' => array( $cap ), 'fields' => 'ids' ) ) as $user_id ) {
		$user = new \WP_User( $user_id );
		$user->remove_cap( $cap );
	}
}
