export interface CatalogCategory { id: string; code: string; name: string; nameHi: string | null; automatic: boolean; subCategories: { id: string; code: string; name: string }[]; capacityBands: { id: string; min: string; max: string; unit: string }[] }
export interface Catalog { accuracyClasses: { id: string; code: string; name: string }[]; categories: CatalogCategory[] }
export interface Instrument {
  id: string; instrumentNo: string; category: { id: string; code: string; name: string }; subCategoryId: string | null; capacityBandId: string; accuracyClassId: string; classCode: string; capacity: string; capacityUnit: string;
  serialNo: string; make: string; model: string | null; manufactureYear: number | null; loadCellSerial: string | null; displayCount: number | null; area: { id: string; code: string; name: string }; address: string | null;
  status: string; outOfArea: boolean; firstVerifiedAt: string | null; version: number; createdAt: string; ownership: 'SELF' | 'ON_BEHALF';
}
export const statusTone = (s: string): 'ok' | 'warn' | 'danger' | 'muted' | 'info' => ({ REGISTERED: 'info', VERIFIED: 'ok', EXPIRED: 'danger', DEREGISTERED: 'muted' } as Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'info'>)[s] ?? 'muted';
