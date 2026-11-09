import { useEffect, useState } from 'preact/hooks';
import { api, type Address, type Customer, type CustomerProfile, type OrderSummary, type ShipTo } from '../api';
import { db } from '../db';
import { money } from '../money';
import { boot, cart, online, queue } from '../state';
import { shopDate } from '../time';
import { pollToPack } from '../sync';
import { Modal, Spinner } from '../ui';
import { OrderDetail } from './orders';

const label = (c: Customer) => `${c.first_name} ${c.last_name}`.trim() || c.email;

export const noAddress = (): Address => ({ address_1: '', address_2: '', city: '', postcode: '', state: '', country: '' });

/** An address as printed, a line each, leaving out what is empty. */
export function addressLines(a: Partial<ShipTo>) {
  const country = a.country ? boot.value?.countries?.[a.country] ?? a.country : '';
  const town = [a.city, a.state, a.postcode].filter(Boolean).join(' ');
  return [`${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(), a.address_1, a.address_2, town, country, a.phone].filter((l): l is string => !!l);
}

/** Customers used on this till before, so a regular can still be picked offline. */
async function searchCached(q: string) {
  const needle = q.toLowerCase();
  const all = await (await db()).getAll('customers');
  return all.filter((c) => [label(c), c.email, c.phone].some((v) => v.toLowerCase().includes(needle))).slice(0, 20);
}

/** Where a delivery to a customer goes, until the cashier changes it. */
export function shipToFor(c: Customer | null): ShipTo {
  const address = c?.address?.address_1 ? c.address : noAddress();
  return {
    ...address,
    first_name: c?.first_name ?? '',
    last_name: c?.last_name ?? '',
    phone: c?.phone ?? '',
    country: address.country || boot.value?.base_country || '',
  };
}

async function choose(c: Customer | null) {
  const { customer, fulfil } = cart.value;
  // A delivery filled in from the last customer's details, and not changed since, goes to this one.
  const moved = fulfil?.how === 'deliver' && JSON.stringify(fulfil.to) === JSON.stringify(shipToFor(customer));
  cart.value = { ...cart.value, customer: c, fulfil: moved ? { how: 'deliver', to: shipToFor(c) } : fulfil };
  if (c) await (await db()).put('customers', c);
}

export function AddressFields({ value, onInput, countries, required = false }: { value: Address; onInput: (a: Address) => void; countries?: string[]; required?: boolean }) {
  const names = boot.value?.countries ?? {};
  const field = (k: keyof Address, title: string) => (
    <label>
      {title}
      <input value={value[k]} onInput={(e) => onInput({ ...value, [k]: e.currentTarget.value })} required={required && (k === 'address_1' || k === 'city')} />
    </label>
  );
  return (
    <>
      {field('address_1', 'Street')}
      {field('address_2', 'Street, line 2')}
      <div class="inline">
        {field('city', 'Town or city')}
        {field('postcode', 'Postcode')}
      </div>
      <div class="inline">
        {field('state', 'County or state')}
        <label>
          Country
          <select value={value.country} onChange={(e) => onInput({ ...value, country: e.currentTarget.value })} required={required}>
            <option value="">Choose</option>
            {(countries ?? Object.keys(names)).map((code) => (
              <option key={code} value={code}>
                {names[code] ?? code}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

type CustomerFields = Omit<Customer, 'id' | 'address'> & { address: Address };

function CustomerForm({ initial, action, onSave, lockEmail = false }: { initial: CustomerFields; action: string; onSave: (f: CustomerFields) => Promise<void>; lockEmail?: boolean }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = (k: 'first_name' | 'last_name' | 'email' | 'phone', title: string, type = 'text') => (
    <label>
      {title}
      <input
        type={type}
        value={form[k]}
        onInput={(e) => setForm({ ...form, [k]: e.currentTarget.value })}
        required={k === 'email'}
        readOnly={k === 'email' && lockEmail}
        title={k === 'email' && lockEmail ? "Only staff who can edit users can change a customer's email" : undefined}
        autofocus={k === 'first_name'}
      />
    </label>
  );
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="form" onSubmit={submit}>
      <div class="inline">
        {field('first_name', 'First name')}
        {field('last_name', 'Last name')}
      </div>
      {field('email', 'Email', 'email')}
      {field('phone', 'Phone', 'tel')}
      <details open={!!initial.address.address_1}>
        <summary>Address</summary>
        <AddressFields value={form.address} onInput={(address) => setForm({ ...form, address })} />
      </details>
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy}>
        {busy ? <Spinner /> : action}
      </button>
    </form>
  );
}

function CreateCustomer({ initial, onDone }: { initial: string; onDone: () => void }) {
  // Whatever was searched for is most likely the new customer's name, email or phone.
  const [first = '', ...rest] = /[@\d]/.test(initial) ? [] : initial.trim().split(/\s+/);
  const fields = {
    first_name: first,
    last_name: rest.join(' '),
    email: initial.includes('@') ? initial : '',
    phone: /^\+?[\d\s-]+$/.test(initial) ? initial : '',
    address: noAddress(),
  };
  return (
    <CustomerForm
      initial={fields}
      action="Create customer"
      onSave={async (f) => {
        await choose(await api.createCustomer(f));
        onDone();
      }}
    />
  );
}

/** What the shop knows of a customer: their details, what they have bought, and sales on this till still to sync. */
function CustomerDetail({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const unsynced = queue.value.filter((q) => q.payload.customer_id === customer.id);
  const load = () => {
    setError('');
    Promise.all([api.customer(customer.id), api.orders('', 1, 'all', '', customer.id)]).then(
      ([p, o]) => (setProfile(p), setOrders(o.orders.slice(0, 5))),
      (e) => setError(e.message),
    );
  };
  useEffect(() => {
    if (online.value) load();
  }, [customer.id, online.value]);
  const shown = profile ?? customer;

  if (editing) {
    const { first_name, last_name, email, phone } = shown;
    return (
      <Modal key="edit" title={`Edit ${label(shown)}`} onClose={() => setEditing(false)}>
        <CustomerForm
          initial={{ first_name, last_name, email, phone, address: shown.address ?? noAddress() }}
          action="Save"
          lockEmail={!boot.value?.user.can_edit_users}
          onSave={async (f) => {
            const saved = await api.updateCustomer(shown.id, f);
            setProfile(saved);
            const { order_count, total_spent, ...details } = saved;
            if (cart.value.customer?.id === saved.id) await choose(details);
            setEditing(false);
          }}
        />
      </Modal>
    );
  }

  return (
    <Modal
      title={label(shown)}
      onClose={onClose}
      footer={
        <button disabled={!profile} onClick={() => setEditing(true)}>
          Edit
        </button>
      }
    >
      <div class="fulfilment">
        <p>{[shown.email, ...addressLines({ ...shown.address, phone: shown.phone })].join('\n')}</p>
      </div>
      {error && <p class="error">{error}</p>}
      {!online.value ? (
        <p class="muted">Order history and changes need a connection.</p>
      ) : (
        !profile && !error && <Spinner />
      )}
      {profile && (
        <p>
          {profile.order_count} order{profile.order_count === 1 ? '' : 's'}, {money(profile.total_spent)} spent in all.
        </p>
      )}
      <ul class="order-list">
        {orders.map((o) => (
          <li key={o.id}>
            <button class="row-button grow" onClick={() => setOpen(o.id)}>
              <strong>#{o.number}</strong>
              <span class="muted">{o.date ? shopDate(o.date) : ''}</span>
              <span class={`status ${o.status}`}>{o.status}</span>
              <strong class="num">{money(o.total)}</strong>
            </button>
          </li>
        ))}
      </ul>
      {unsynced.length > 0 && (
        <p class="muted small">
          {unsynced.length} sale{unsynced.length === 1 ? '' : 's'} on this till still to sync, {money(unsynced.reduce((s, q) => s + q.receipt.total, 0))} in all.
        </p>
      )}
      {open !== null && <OrderDetail id={open} onClose={() => (setOpen(null), load(), void pollToPack().catch(() => {}))} />}
    </Modal>
  );
}

export function CustomerPicker({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(false);
  const current = cart.value.customer;

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const found = online.value ? await api.customers(q.trim()).catch(() => searchCached(q.trim())) : await searchCached(q.trim());
        if (!cancelled) setResults(found);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setBusy(false);
    };
  }, [q]);

  if (creating) {
    return (
      <Modal key="new" title="New customer" onClose={onClose}>
        {online.value ? <CreateCustomer initial={q} onDone={onClose} /> : <p class="muted">Creating a customer needs a connection.</p>}
      </Modal>
    );
  }
  if (viewing && current) return <CustomerDetail key="detail" customer={current} onClose={() => setViewing(false)} />;

  return (
    <Modal title="Customer" onClose={onClose}>
      {current && (
        <div class="row-button">
          <span class="grow">
            <strong>{label(current)}</strong> <span class="muted">{current.email}</span>
          </span>
          <button class="link" onClick={() => setViewing(true)}>
            Details
          </button>
          <button
            class="link"
            onClick={() => {
              void choose(null);
              onClose();
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div class="search-bar">
        <input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Name, email or phone" autofocus aria-label="Search customers" data-scan />
        {busy && <Spinner />}
      </div>
      {!online.value && <p class="muted small">Offline: searching customers used on this till.</p>}
      <div class="variation-list">
        {results.map((c) => (
          <button
            key={c.id}
            class="row-button customer-row"
            onClick={() => {
              void choose(c);
              onClose();
            }}
          >
            <strong>{label(c)}</strong>
            <span class="muted small">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {q.trim().length >= 2 && !busy && results.length === 0 && <p class="muted">No customers found.</p>}
      </div>
      <button onClick={() => setCreating(true)}>+ New customer</button>
    </Modal>
  );
}
