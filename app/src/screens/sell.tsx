import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Product } from '../api';
import { cameraScanSupported, findByCode, listenForScans, scanWithCamera } from '../barcode';
import { money } from '../money';
import { available, canSell, inStock, onBackorder, sell, sellCode } from '../selling';
import { addedBuzz } from '../sound';
import { cartWidth } from '../prefs';
import { recent } from '../recent';
import { boot, cart, catalogue, notify, products } from '../state';
import { Modal } from '../ui';
import { CartPanel } from './cart-panel';

function variationsOf(parent: Product) {
  const all = products.value;
  return (parent.variation_ids ?? []).map((id) => all.get(id)).filter((v): v is Product => !!v && v.price !== null);
}

function priceLabel(p: Product) {
  if (p.type !== 'variable') return p.price === null ? '' : money(p.price);
  const prices = variationsOf(p).map((v) => v.price as number);
  if (!prices.length) return '';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`;
}

function StockBadge({ p }: { p: Product }) {
  if (p.type === 'variable') return null;
  if (!inStock(p)) return onBackorder(p) ? <span class="badge low">Backorder</span> : <span class="badge out">Out</span>;
  const left = available(p);
  if (left !== null && left <= 5) return <span class="badge low">{left} left</span>;
  return null;
}

function Tile({ p, onPick, inSale }: { p: Product; onPick: (p: Product) => void; inSale: Map<number, number> }) {
  const disabled = p.type !== 'variable' && (p.price === null || !canSell(p));
  // A variable parent counts what its variations put on the sale.
  const count = p.type === 'variable' ? (p.variation_ids ?? []).reduce((n, id) => n + (inSale.get(id) ?? 0), 0) : inSale.get(p.id) ?? 0;
  return (
    <button class={p.image ? 'tile' : 'tile text'} disabled={disabled} onClick={() => onPick(p)} title={p.sku ? `${p.name} (${p.sku})` : p.name}>
      {p.image && <img src={p.image} alt="" loading="lazy" />}
      <span class="name">{p.name}</span>
      <span class="price">{priceLabel(p)}</span>
      {count > 0 && <span class="badge in-sale">×{count}</span>}
      <StockBadge p={p} />
    </button>
  );
}

function VariationPicker({ parent, onClose }: { parent: Product; onClose: () => void }) {
  const variations = variationsOf(parent);
  return (
    <Modal title={parent.name} onClose={onClose}>
      {variations.length === 0 && <p class="muted">No variations have a price yet.</p>}
      <div class="variation-list">
        {variations.map((v) => (
          <button
            key={v.id}
            class="row-button"
            disabled={!canSell(v)}
            onClick={() => {
              sell(v);
              addedBuzz();
              onClose();
            }}
          >
            <span>{Object.values(v.attributes ?? {}).join(' / ') || v.name}</span>
            <StockBadge p={v} />
            <strong>{money(v.price ?? 0)}</strong>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function CameraScan({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    scanWithCamera(video.current!, abort.signal)
      .then((code) => code && onCode(code))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => abort.abort();
  }, []);
  return (
    <Modal title="Scan a barcode" onClose={onClose}>
      {error ? <p class="error">{error}</p> : <video ref={video} class="camera" muted playsInline />}
    </Modal>
  );
}

/**
 * The handle between the products and the sale. Dragged (or arrow-keyed) wider or narrower;
 * the product grid is auto-fill, so it gives the panel room a column at a time. The width is
 * the device's, remembered like the other per-device choices; a double-click or Home takes
 * it back to the default. While it is being dragged the width is written to the style alone,
 * so a hundred pointer moves cost no saves — the one width is kept when the drag lets go.
 */
function Divider() {
  const dragging = useRef<{ x: number; w: number } | null>(null);
  const last = useRef(400);
  const [active, setActive] = useState(false);
  const most = () => Math.min(window.innerWidth * 0.6, window.innerWidth - 340);

  const apply = (w: number) => {
    const px = Math.round(Math.min(most(), Math.max(320, w)));
    document.documentElement.style.setProperty('--cart-w', `${px}px`);
    last.current = px;
    return px;
  };

  const end = () => {
    dragging.current = null;
    setActive(false);
    document.body.classList.remove('dragging-cart');
    cartWidth.value = last.current;
  };

  return (
    <div
      class={`divider${active ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sale panel"
      aria-valuemin={320}
      aria-valuemax={Math.round(most())}
      aria-valuenow={cartWidth.value ?? 400}
      title="Drag to resize the sale panel — double-click to reset"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = { x: e.clientX, w: document.getElementById('cart')?.offsetWidth ?? cartWidth.value ?? 400 };
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        document.body.classList.add('dragging-cart');
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (d) apply(d.w + (d.x - e.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDblClick={() => (cartWidth.value = null)}
      onKeyDown={(e) => {
        const now = cartWidth.value ?? 400;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          cartWidth.value = apply(now + 24);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          cartWidth.value = apply(now - 24);
        } else if (e.key === 'Home') {
          e.preventDefault();
          cartWidth.value = null;
        }
      }}
    />
  );
}

export function Sell() {
  const [search, setSearch] = useState('');
  // Undefined until the cashier picks one.
  const [chosen, setCategory] = useState<number | null | 'pinned' | 'recent'>();
  const [picking, setPicking] = useState<Product | null>(null);
  const [camera, setCamera] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const pick = (p: Product) => (p.type === 'variable' ? setPicking(p) : (sell(p), addedBuzz()));

  const scanned = (code: string) => sellCode(code) && (addedBuzz(), setSearch(''));

  // Scans only add to the sale when no dialog (checkout, refund, a form) is open.
  useEffect(() => listenForScans((code) => (document.querySelector('.overlay') ? notify('Close the dialog to add scanned items.', 'error') : scanned(code))), []);

  // '/' goes to the search, for tills driven from a keyboard as much as a touchscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return;
      if (document.querySelector('.modal')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pinned = catalogue.value.some((p) => p.pinned);
  // A shop that pins its everyday items gets them as the first screen, whenever the catalogue arrives.
  const category = chosen === undefined || (chosen === 'pinned' && !pinned) ? (pinned ? 'pinned' : null) : chosen;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalogue.value.filter((p) => {
      // A search looks past the pinned and recent few.
      if (category === 'pinned' ? !q && !p.pinned : category === 'recent' ? !q && !recent.value.includes(p.id) : category !== null && !p.category_ids.includes(category)) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.gtin === q;
    });
  }, [catalogue.value, search, category]);

  // The chip itself is this device's own selling order, freshest first.
  const ordered = useMemo(
    () => (category === 'recent' ? [...visible].sort((a, b) => recent.value.indexOf(a.id) - recent.value.indexOf(b.id)) : visible),
    [visible, category, recent.value],
  );

  // Quantities already on the sale, so a glance at the grid says what's rung up.
  const inSale = useMemo(() => {
    const map = new Map<number, number>();
    for (const l of cart.value.lines) if (l.productId) map.set(l.productId, (map.get(l.productId) ?? 0) + l.qty);
    return map;
  }, [cart.value.lines]);

  const categories = (boot.value?.categories ?? []).filter((c) => catalogue.value.some((p) => p.category_ids.includes(c.id)));

  const onSearchKey = (e: KeyboardEvent) => {
    // The grid is reachable from the keys: down goes to the first tile, and the arrows walk it.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      gridRef.current?.querySelector<HTMLElement>('button.tile:not([disabled])')?.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    const exact = findByCode(products.value.values(), search);
    if (exact) {
      sell(exact);
      addedBuzz();
      setSearch('');
    } else if (visible.length === 1) {
      pick(visible[0]);
      setSearch('');
    }
  };

  // Arrows walk the grid a column at a time; Enter on a tile is its own tap; Esc climbs back to the search.
  const onGridKey = (e: KeyboardEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !el.matches('button.tile')) return;
    const grid = gridRef.current!;
    const tiles = [...grid.querySelectorAll<HTMLElement>('button.tile')];
    const i = tiles.indexOf(el as HTMLElement);
    if (i < 0) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
    const go = (j: number) => {
      e.preventDefault();
      tiles[Math.max(0, Math.min(tiles.length - 1, j))]?.focus();
    };
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowDown') go(i + cols);
    else if (e.key === 'ArrowUp') {
      if (i - cols < 0) {
        e.preventDefault();
        searchRef.current?.focus();
      } else go(i - cols);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchRef.current?.focus();
    }
  };

  return (
    <div class="sell">
      <section class="products">
        <div class="search-bar">
          <input
            ref={searchRef}
            type="search"
            placeholder="Search name, SKU or barcode"
            value={search}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={onSearchKey}
            aria-label="Search products"
          />
          {cameraScanSupported() && (
            <button class="icon" onClick={() => setCamera(true)} aria-label="Scan with camera" title="Scan with camera">
              ⌗
            </button>
          )}
        </div>
        {(categories.length > 0 || pinned || recent.value.length > 0) && (
          <div class="chips">
            {pinned && (
              <button class={category === 'pinned' ? 'chip active' : 'chip'} aria-pressed={category === 'pinned'} onClick={() => setCategory('pinned')}>
                Pinned
              </button>
            )}
            {recent.value.length > 0 && (
              <button class={category === 'recent' ? 'chip active' : 'chip'} aria-pressed={category === 'recent'} onClick={() => setCategory('recent')}>
                Recent
              </button>
            )}
            <button class={category === null ? 'chip active' : 'chip'} aria-pressed={category === null} onClick={() => setCategory(null)}>
              All
            </button>
            {categories.map((c) => (
              <button key={c.id} class={category === c.id ? 'chip active' : 'chip'} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div class="grid" ref={gridRef} onKeyDown={onGridKey}>
          {ordered.map((p) => (
            <Tile key={p.id} p={p} onPick={pick} inSale={inSale} />
          ))}
          {visible.length === 0 && (
            <p class="muted empty">{products.value.size ? (search.trim() ? <>No products match “{search.trim()}”.</> : 'No products in this category.') : 'No products synced yet.'}</p>
          )}
        </div>
      </section>
      <Divider />
      <CartPanel />
      {picking && <VariationPicker parent={picking} onClose={() => setPicking(null)} />}
      {camera && (
        <CameraScan
          onClose={() => setCamera(false)}
          onCode={(code) => {
            setCamera(false);
            scanned(code);
          }}
        />
      )}
    </div>
  );
}
