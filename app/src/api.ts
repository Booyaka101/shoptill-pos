import type { TaxConfig } from './totals';

declare global {
  interface Window {
    SHOPTILL?: { restRoot: string; appUrl: string; swUrl: string; version: string; shopName: string };
  }
}

export const config = window.SHOPTILL ?? {
  restRoot: '/wp-json/shoptill/v1/',
  appUrl: '/',
  swUrl: '/sw.js',
  version: 'dev',
  shopName: 'Dev shop',
};

export interface Product {
  id: number;
  parent_id: number;
  type: 'simple' | 'variable' | 'variation';
  name: string;
  sku: string;
  gtin: string;
  price: number | null;
  regular_price: number | null;
  on_sale: boolean;
  tax_status: 'taxable' | 'shipping' | 'none';
  tax_class: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  /** The product holding the stock: a variation can sell from its parent's. */
  stock_id?: number | null;
  stock_status: string;
  /** Missing on products cached before the till synced it. */
  backorders?: boolean;
  sold_individually: boolean;
  image: string | null;
  category_ids: number[];
  /** Featured in WooCommerce, shown first on the till. */
  pinned?: boolean;
  /** Unit cost from the shop's cost-of-goods plugin, for staff who may edit products. */
  cost?: number | null;
  attributes?: Record<string, string>;
  variation_ids?: number[];
}

export interface Register {
  id: string;
  name: string;
  outlet: string;
}

export interface User {
  id: number;
  name: string;
  can_refund: boolean;
  /** May change prices and stock from the till. */
  can_edit?: boolean;
  /** Sees web orders and moves them along. */
  can_manage_orders?: boolean;
  /** May move a customer to another email. */
  can_edit_users?: boolean;
}

export interface StoreInfo {
  store_name: string;
  address: string[];
  logo: string;
  header: string;
  footer: string;
  phone: string;
  tax_number: string;
  show_sku: boolean;
  width: '80' | '58' | 'a4';
}

export interface Currency {
  code: string;
  symbol: string;
  position: 'left' | 'right' | 'left_space' | 'right_space';
  decimals: number;
  decimal_separator: string;
  thousand_separator: string;
}

export interface Bootstrap {
  user: User;
  store: StoreInfo;
  registers: Register[];
  payment_methods: Record<string, string>;
  allow_oversell: boolean;
  pay_later: boolean;
  /** Whether the charge screen offers a tip. */
  tips?: boolean;
  /** Whether this account may change an item's price or discount it at the till. */
  may_change_prices: boolean;
  tax: TaxConfig;
  categories: { id: number; name: string; parent: number }[];
  currency: Currency;
  server_time: number;
  /** Plugin version on the server; a newer one than this page was built with means a reload is due. */
  version: string;
  /** The shop's offset from UTC in seconds, so "today" means the shop's day, not the device's. */
  utc_offset: number;
  /** Named shop timezone, when available, so historical times follow daylight-saving rules. */
  timezone?: string;
  /** Whether a cost-of-goods plugin is active, so costs and profit can be shown to staff. */
  cogs?: boolean;
  /** Countries the shop sells to, by code. Missing from a bootstrap cached by an older version. */
  countries?: Record<string, string>;
  ship_countries?: string[];
  base_country?: string;
}

export interface Address {
  address_1: string;
  address_2: string;
  city: string;
  postcode: string;
  state: string;
  country: string;
}

export interface ShipTo extends Address {
  first_name: string;
  last_name: string;
  phone: string;
}

export interface Customer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  /** Missing on customers cached before the till kept addresses. */
  address?: Address;
}

export interface CustomerProfile extends Customer {
  order_count: number;
  total_spent: number;
}

export interface Payment {
  method: string;
  label?: string;
  amount: number;
  tendered?: number;
  change?: number;
  reference?: string;
}

export interface OrderItem {
  id: number;
  product_id: number;
  name: string;
  sku: string;
  qty: number;
  qty_refunded: number;
  subtotal: number;
  subtotal_tax: number;
  total: number;
  total_tax: number;
  /** Tax by rate, which a refund rounds one by one. */
  taxes: number[];
  refunded: number;
  /** Tax refunded so far, by rate in the same order as taxes. */
  tax_refunded: number[];
  meta: { key: string; value: string }[];
}

export interface OrderSummary {
  id: number;
  number: string;
  status: string;
  date: number | null;
  total: number;
  refunded: number;
  customer: string;
  payment: string;
  pos: boolean;
  client_id: string;
  item_count: number;
  shipping_method: string;
  /** A till sale handed over later. */
  fulfil: '' | 'collect' | 'deliver';
}

export interface Order extends OrderSummary {
  items: OrderItem[];
  coupons: { code: string; discount: number }[];
  subtotal: number;
  /** The shipping line, which a till delivery charge or a web checkout adds. */
  shipping_total: number;
  shipping_tax: number;
  fees?: { name: string; total: number; total_tax: number }[];
  discount_total: number;
  discount_tax: number;
  total_tax: number;
  taxes: { label: string; amount: number }[];
  prices_include_tax: boolean;
  payments: Payment[];
  refunds: { id: number; amount: number; reason: string; date: number | null; method: string }[];
  remaining_refund: number;
  /** Still to pay on a sale put on account or synced underpaid. */
  owed: number;
  email: string;
  phone: string;
  billing_address: string[];
  shipping_address: string[];
  note: string;
  notes: { id: number; content: string; customer: boolean; date: number | null; by: string }[];
  register: Register | null;
  cashier: number;
  cashier_name: string;
}

export interface Summary {
  date: string;
  register_id: string;
  totals: {
    orders: number;
    items: number;
    gross: number;
    tax: number;
    discounts: number;
    refunds: number;
    net: number;
    owed: number;
    repaid: number;
    web_refunds: number;
    paid_in: number;
    paid_out: number;
    /** Delivery charges with their tax, which the product breakdown leaves out. */
    shipping: number;
    /** Gratuities, separate from product sales. Missing on older servers. */
    tips?: number;
    /** Staff only: what the day's sales cost, the profit on them, and what was sold with no cost known. */
    cost?: number;
    profit?: number;
    uncosted?: number;
  };
  by_method: { method: string; label: string; sales: number; refunds: number }[];
  by_product: { key: string; name: string; sku: string; qty: number; refunded: number; sales: number; cost?: number | null; uncosted?: boolean }[];
  by_cashier: { id: number; name: string; orders: number; sales: number }[];
  closes: DrawerClose[];
  cash_moves: CashMove[];
}

/** Cash put into the drawer, or taken out when negative, outside a sale. */
export interface CashMove {
  register_id: string;
  amount: number;
  reason: string;
  cashier: number;
  cashier_name: string;
  at: number;
  /** Set when it was made after the drawer was last counted, so that count didn't see it. */
  after_close?: boolean;
}

export interface DrawerClose {
  register_id: string;
  float: number;
  counted: number;
  expected: number;
  difference: number;
  cashier: number;
  cashier_name: string;
  at: number;
}

/** The request never reached WordPress: offline, DNS, timeout. */
export class NetworkError extends Error {}

/** WordPress answered with an error. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};

export function setToken(value: string | null) {
  token = value;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function request<T>(path: string, init: { method?: string; body?: unknown; timeout?: number } = {}): Promise<T> {
  const controller = new AbortController();
  // Covers reading the body too: a connection that dies half way through an answer must not hang the till.
  const timer = setTimeout(() => controller.abort(), init.timeout ?? 20_000);
  const sent = token;
  let res: Response;
  let json: any = null;
  try {
    res = await fetch(config.restRoot + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(sent ? { Authorization: `Basic ${sent}` } : {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      credentials: 'omit',
    });
    try {
      json = await res.json();
    } catch (e) {
      // Hosts sometimes answer a failed request with an HTML error page. A good answer cut short is lost.
      if (res.ok) throw e;
    }
  } catch {
    throw new NetworkError(controller.signal.aborted ? "The shop didn't answer in time. Check the connection and try again." : "Couldn't reach the shop. Check the connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // A request the last user sent says nothing about whoever has signed in since.
    if (res.status === 401 && sent && sent === token) onUnauthorized();
    throw new ApiError(json?.message ?? `Request failed (${res.status})`, res.status, json?.code ?? 'http_error', json?.data ?? {});
  }
  return json as T;
}

export const api = {
  login: (username: string, password: string, device: string) =>
    request<{ token: string; user: User }>('auth/login', { body: { username, password, device } }),
  logout: () => request('auth/logout', { body: {} }),
  bootstrap: () => request<Bootstrap>('bootstrap'),
  products: (after: number, modifiedAfter?: number) =>
    request<{ products: Product[]; next_after: number | null }>(
      `products?per_page=100&after=${after}${modifiedAfter ? `&modified_after=${modifiedAfter}` : ''}`,
      { timeout: 60_000 },
    ),
  productIds: () => request<number[]>('products/ids', { timeout: 60_000 }),
  updateProduct: (id: number, body: unknown) => request<Product>(`products/${id}`, { body }),
  stock: () => request<{ id: number; stock_quantity: number | null; stock_status: string }[]>('stock'),
  customers: (search: string) => request<Customer[]>(`customers?search=${encodeURIComponent(search)}`),
  createCustomer: (c: Omit<Customer, 'id'>) => request<Customer>('customers', { body: c }),
  customer: (id: number) => request<CustomerProfile>(`customers/${id}`),
  updateCustomer: (id: number, c: Partial<Omit<Customer, 'id'>>) => request<CustomerProfile>(`customers/${id}`, { body: c }),
  preview: (body: unknown) =>
    request<{ coupons: { code: string; discount: number }[]; lines: { coupon_discount: number }[] }>('orders/preview', { body }),
  createOrder: (body: unknown) => request<Order>('orders', { body, timeout: 45_000 }),
  orders: (search: string, page: number, source: 'pos' | 'web' | 'all' | 'later', status = '', customerId = 0) =>
    request<{ orders: OrderSummary[]; total: number; total_pages: number }>(
      `orders?search=${encodeURIComponent(search)}&page=${page}&source=${source}&status=${status}${customerId ? `&customer_id=${customerId}` : ''}`,
    ),
  order: (id: number) => request<Order>(`orders/${id}`),
  refund: (id: number, body: unknown) => request<Order>(`orders/${id}/refund`, { body }),
  pay: (id: number, body: unknown) => request<Order>(`orders/${id}/pay`, { body }),
  setStatus: (id: number, status: string) => request<Order>(`orders/${id}/status`, { body: { status } }),
  addNote: (id: number, body: { note: string; customer: boolean; request_id: string }) => request<Order>(`orders/${id}/note`, { body }),
  email: (id: number, email: string) => request<{ ok: boolean }>(`orders/${id}/email`, { body: { email } }),
  summary: (date: string, registerId: string) =>
    request<Summary>(`reports/summary?date=${date}&register_id=${encodeURIComponent(registerId)}`),
  closeDrawer: (body: { date: string; register_id: string; float: number; counted: number; request_id: string }) => request<DrawerClose>('reports/close', { body }),
  moveCash: (body: { date: string; register_id: string; amount: number; reason: string; request_id: string }) => request<CashMove>('reports/cash', { body }),
};
