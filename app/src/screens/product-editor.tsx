import { useState } from 'preact/hooks';
import { api, ApiError, type Product } from '../api';
import { parseAmount } from '../money';
import { boot, notify, products, reserved, stockHolder } from '../state';
import { pollStock, saveEdited } from '../sync';
import { Modal, Spinner } from '../ui';

/** Price and stock for one product, changed at the till by staff who may edit products. */
export function ProductEditor({ product, onClose }: { product: Product; onClose: () => void }) {
  const withCost = !!boot.value?.cogs && product.cost !== undefined;
  // What the fields opened with. A sync or stock poll can change the product under an open dialog,
  // and only what the cashier changed is sent.
  const [start, setStart] = useState(() => ({
    regular: product.regular_price === null ? '' : String(product.regular_price),
    sale: product.on_sale && product.price !== null ? String(product.price) : '',
    stock: product.stock_quantity === null ? '' : String(product.stock_quantity),
    cost: product.cost === null || product.cost === undefined ? '' : String(product.cost),
  }));
  const [regular, setRegular] = useState(start.regular);
  const [sale, setSale] = useState(start.sale);
  const [stock, setStock] = useState(start.stock);
  const [cost, setCost] = useState(start.cost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A count taken while this till still has sales of it to sync would have them taken off twice.
  const unsynced = reserved.value.get(stockHolder(product.id)) ?? 0;

  const save = async (e: Event) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if ([regular, sale, stock, cost].map(parseAmount).some(Number.isNaN)) return setError('That is not a number.');
    // A blank price or stock keeps what was there rather than setting it to zero. A blank sale price ends the sale.
    if (regular.trim() && regular !== start.regular) body.regular_price = parseAmount(regular);
    if (sale !== start.sale) body.sale_price = sale.trim() ? parseAmount(sale) : '';
    if (withCost && cost !== start.cost) body.cost = cost.trim() ? parseAmount(cost) : '';
    if (product.manage_stock && !unsynced && stock.trim() && stock !== start.stock) {
      body.stock = Math.max(0, Math.floor(parseAmount(stock)));
      body.stock_was = start.stock === '' ? null : Number(start.stock);
    }
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    setError('');
    try {
      await saveEdited(await api.updateProduct(product.id, body));
      notify(`${product.name} updated.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.code === 'shoptill_stock_changed') {
        await pollStock().catch(() => {});
        const now = String(products.value.get(product.id)?.stock_quantity ?? '');
        setStart((s) => ({ ...s, stock: now }));
        setStock(now);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit ${product.name}`}
      onClose={onClose}
      footer={
        <button class="primary" type="submit" form="product-editor" disabled={busy}>
          {busy ? <Spinner /> : 'Save to shop'}
        </button>
      }
    >
      <form id="product-editor" class="form" onSubmit={save}>
        <label>
          Regular price
          <input inputMode="decimal" value={regular} onInput={(e) => setRegular(e.currentTarget.value)} autofocus />
        </label>
        <label>
          Sale price
          <input inputMode="decimal" value={sale} onInput={(e) => setSale(e.currentTarget.value)} placeholder="Not on sale" />
        </label>
        {product.manage_stock && (
          <label>
            In stock
            <input inputMode="numeric" value={stock} onInput={(e) => setStock(e.currentTarget.value)} disabled={unsynced > 0} />
          </label>
        )}
        {withCost && (
          <label>
            Cost
            <input inputMode="decimal" value={cost} onInput={(e) => setCost(e.currentTarget.value)} placeholder="No cost set" />
          </label>
        )}
        {unsynced > 0 && <p class="muted small">This till has sales of it that haven't reached the shop. Count the stock once they sync, or once they're discarded under Orders.</p>}
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
