export const CENTRAL_CATALOG_ITEM_KINDS = ['loadout', 'materia'] as const;
export type CentralCatalogItemKind = (typeof CENTRAL_CATALOG_ITEM_KINDS)[number];
export type CentralCatalogKindFilter = CentralCatalogItemKind | 'all';

export interface CentralCatalogProvenance {
  readonly [key: string]: unknown;
}

export interface CentralCatalogItemSummary {
  readonly id: string;
  readonly kind: CentralCatalogItemKind;
  readonly name?: string;
  readonly description?: string;
  readonly version: string;
  readonly updatedAt: string;
  readonly contentHash: string;
  readonly provenance?: CentralCatalogProvenance;
}

export interface CentralCatalogItem extends CentralCatalogItemSummary {
  readonly content: {
    readonly definition: Readonly<Record<string, unknown>>;
  };
}

export interface CentralCatalogFilters {
  readonly kind: CentralCatalogKindFilter;
  readonly search: string;
}
