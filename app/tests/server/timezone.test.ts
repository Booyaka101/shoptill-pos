import { describe, expect, it } from 'vitest';
import { wp } from '../wp';

const url = process.env.SHOPTILL_URL;
const token = process.env.SHOPTILL_ADMIN_TOKEN;

describe.skipIf(!url || !token)('report day boundaries', () => {
  it.each([
    ['2026-03-08', 23],
    ['2026-11-01', 25],
  ])('includes exactly the local day on %s (%s hours)', async (day, hours) => {
    const previous = wp('option', 'get', 'timezone_string').toString().trim();
    const register = `dst-${day}`;
    let ids: number[] = [];
    try {
      const fixture = JSON.parse(wp('eval', `
        update_option('timezone_string', 'America/New_York');
        $start = new DateTimeImmutable('${day}', wp_timezone());
        $end = $start->modify('+1 day');
        $ids = array();
        foreach (array($start->getTimestamp() - 1, $start->getTimestamp(), $end->getTimestamp() - 1, $end->getTimestamp()) as $i => $at) {
          $order = wc_create_order();
          $order->set_created_via('shoptill');
          $order->set_date_created($at);
          $order->set_status('completed');
          $order->set_total(pow(2, $i));
          $order->update_meta_data(ShopTill\\Orders::META_REGISTER, array('id' => '${register}'));
          $order->save();
          $ids[] = $order->get_id();
        }
        echo wp_json_encode(array('ids' => $ids, 'hours' => ($end->getTimestamp() - $start->getTimestamp()) / 3600));
      `).toString());
      ids = fixture.ids;
      expect(fixture.hours).toBe(hours);
      const response = await fetch(`${url}/wp-json/shoptill/v1/reports/summary?date=${day}&register_id=${register}`, {
        headers: { Authorization: `Basic ${token}` },
      });
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report.date).toBe(day);
      expect(report.totals.orders).toBe(2);
      expect(report.totals.gross).toBe(6);
    } finally {
      wp('eval', `update_option('timezone_string', ${JSON.stringify(previous)}); foreach (array(${ids.join(',')}) as $id) { $order = wc_get_order($id); if ($order) $order->delete(true); }`);
    }
  }, 60_000);
});
