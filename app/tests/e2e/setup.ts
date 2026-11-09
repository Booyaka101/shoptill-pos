import { wp } from '../wp';

/** Reseeds the dev shop so stock and prices are known before each run. */
export default function setup() {
  if (process.env.SHOPTILL_URL) return;
  wp('eval-file', '/dev-scripts/seed.php', 'exclusive');
  wp('option', 'update', 'shoptill_pay_later', 'yes');
}
