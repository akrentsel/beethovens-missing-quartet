// Catalogue loading and validation. The catalogue is the source of truth for
// which composers, forms and published works exist; the database is the source
// of truth for request status and votes.
import { readFileSync } from 'node:fs';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function loadCatalog(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read catalogue at ${path}: ${err.message}`);
  }
  return validateCatalog(data);
}

export function validateCatalog(data) {
  if (!data || typeof data !== 'object') throw new Error('Catalogue must be an object');
  const { composers, forms, works = [] } = data;
  if (!Array.isArray(composers) || !Array.isArray(forms) || !Array.isArray(works)) {
    throw new Error('Catalogue needs composers, forms and works arrays');
  }
  const composerIds = new Set();
  for (const c of composers) {
    if (!c || typeof c.id !== 'string' || !SLUG.test(c.id) || c.id.length > 40) {
      throw new Error(`Invalid composer id: ${JSON.stringify(c && c.id)}`);
    }
    if (composerIds.has(c.id)) throw new Error(`Duplicate composer id: ${c.id}`);
    composerIds.add(c.id);
  }
  const formIds = new Set();
  for (const f of forms) {
    if (!f || typeof f.id !== 'string' || !SLUG.test(f.id) || f.id.length > 40) {
      throw new Error(`Invalid form id: ${JSON.stringify(f && f.id)}`);
    }
    if (formIds.has(f.id)) throw new Error(`Duplicate form id: ${f.id}`);
    formIds.add(f.id);
  }
  const workIds = new Set();
  const workRounds = new Set();
  for (const w of works) {
    if (!w || typeof w.id !== 'string' || !SLUG.test(w.id) || w.id.length > 100) {
      throw new Error(`Invalid work id: ${JSON.stringify(w && w.id)}`);
    }
    if (workIds.has(w.id)) throw new Error(`Duplicate work id: ${w.id}`);
    if (!composerIds.has(w.composerId)) throw new Error(`Work ${w.id} has unknown composer`);
    if (!formIds.has(w.formId)) throw new Error(`Work ${w.id} has unknown form`);
    if (!Number.isSafeInteger(w.round) || w.round < 1) throw new Error(`Work ${w.id} has invalid round`);
    const key = `${w.composerId}:${w.formId}:${w.round}`;
    if (workRounds.has(key)) throw new Error(`Two works claim round ${key}`);
    workIds.add(w.id);
    workRounds.add(key);
  }
  return {
    composers: composers.map((c) => c.id),
    forms: forms.map((f) => f.id),
    works: works.map((w) => ({
      id: w.id,
      composerId: w.composerId,
      formId: w.formId,
      round: w.round,
      status: w.status,
      date: typeof w.date === 'string' ? w.date : null,
    })),
  };
}
