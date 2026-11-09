import { describe, expect, it } from 'vitest';
import type { Product } from '../../src/api';
import { decodeScan, findByCode } from '../../src/barcode';

const product = (over: Partial<Product>): Product => ({
  id: 1,
  parent_id: 0,
  type: 'simple',
  name: 'Thing',
  sku: '',
  gtin: '',
  price: 5,
  regular_price: 5,
  on_sale: false,
  tax_status: 'taxable',
  tax_class: '',
  manage_stock: false,
  stock_quantity: null,
  stock_status: 'instock',
  sold_individually: false,
  image: null,
  category_ids: [],
  ...over,
});

describe('decodeScan', () => {
  it('expands UPC-E to the UPC-A it stands for', () => {
    // Number system 0, manufacturer 012345, check 5: UPC-E 01234565 is UPC-A 012345000065.
    expect(decodeScan('01234565').lookup).toBe('012345000065');
    expect(decodeScan('1234565').lookup).toBe('012345000065');
    // The last UPC-E digit picking the pattern.
    expect(decodeScan('01234535').lookup).toBe('012300000455');
    expect(decodeScan('01234545').lookup).toBe('012340000055');
    expect(decodeScan('01234595').lookup).toBe('012345000095');
    // Number system 1.
    expect(decodeScan('11234565').lookup).toBe('112345000065');
  });

  it('leaves other codes alone', () => {
    for (const code of ['9300601000017', '81234565', '4600000000000', 'SCALE-42', '1234']) expect(decodeScan(code).lookup).toBe(code);
  });

  it('reads weight and price labels from scales', () => {
    // Prefix 28: item 12345, 1.250 kg.
    expect(decodeScan('2812345012509')).toEqual({ lookup: '12345', qty: 1.25 });
    // Prefix 29: item 12345, 12.34 of the shop's currency.
    expect(decodeScan('2912345012347')).toEqual({ lookup: '12345', price: 12.34 });
  });
});

describe('findByCode', () => {
  const products = [
    product({ id: 1, sku: '12345', gtin: '012345000065' }),
    product({ id: 2, sku: 'FLAT-WHITE', gtin: '9300601000017' }),
    product({ id: 3, type: 'variable', sku: 'TEE' }),
  ];

  it('matches a UPC-E scan through its UPC-A, by GTIN or SKU', () => {
    expect(findByCode(products, '01234565')?.id).toBe(1);
    expect(findByCode(products, '1234565')?.id).toBe(1);
  });

  it('finds scale labels by their item code as a SKU', () => {
    expect(findByCode(products, '2912345012347')?.id).toBe(1);
  });

  it('still matches GTIN, UPC-A against EAN-13 and SKU, case insensitively', () => {
    expect(findByCode(products, '9300601000017')?.id).toBe(2);
    expect(findByCode(products, '09300601000017')?.id).toBe(2);
    expect(findByCode(products, 'flat-white')?.id).toBe(2);
  });
});
