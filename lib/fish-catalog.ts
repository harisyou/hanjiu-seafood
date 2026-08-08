export type FishCatalogItem = {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
};

export type FishAlias = {
  id: string;
  fish_catalog_id: string;
  alias: string;
  created_at?: string;
};

export function normalizeCatalogTerm(value: string) {
  return value.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim().toLocaleLowerCase("zh-TW");
}
