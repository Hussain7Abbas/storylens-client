import type { ExistingKeyword } from "../backend/api";
import type { PageCharacter, VersionDraft } from "./prompt";

export type RowState = "idle" | "saving" | "saved" | "error";

/** One character in the crawl table, merged across every phase that mentioned it. */
export type CharacterRow = {
  key: string;
  name: string;
  description: string;
  categoryId?: string;
  natureId?: string;
  aliases: string[];
  versions: VersionDraft[];
  /** Titles of the wiki pages that contributed to this row. */
  sources: string[];
  /** Set when the character already exists in the novel or after it is saved. */
  keywordId?: string;
  /** Lowercased names already stored for the keyword (its name and aliases). */
  savedNames: string[];
  /** Starting chapters of the keyword's stored versions. */
  savedChapters: number[];
  state: RowState;
  error?: string;
  /** Explains AI links and anything left unsaved. */
  notes: string[];
};

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&amp;": "&" };
/** The API escapes HTML characters in stored text; comparisons need the plain text back. */
export function decodeStoredText(value: string): string {
  return value.replace(/&(lt|gt|quot|amp|#x27);/g, entity => ENTITIES[entity]);
}
const lower = (value: string) => value.trim().toLowerCase();

export function rowNames(row: Pick<CharacterRow, "name" | "aliases">): string[] {
  return [row.name, ...row.aliases];
}
/** Aliases still missing from the API. */
export function pendingAliases(row: CharacterRow): string[] {
  return row.aliases.filter(alias => !row.savedNames.includes(lower(alias)));
}
/** Versions still missing from the API: those with a chapter after the stored ones. */
export function pendingVersions(row: CharacterRow): VersionDraft[] {
  const latest = Math.max(0, ...row.savedChapters);
  return row.versions.filter(version => version.startingChapter === null || version.startingChapter > latest);
}
export function hasPendingWork(row: CharacterRow): boolean {
  return !row.keywordId || pendingAliases(row).length > 0 || pendingVersions(row).length > 0;
}

function addAliases(row: CharacterRow, names: string[]): void {
  for (const name of names) {
    const key = lower(name);
    if (key && key !== lower(row.name) && !row.aliases.some(alias => lower(alias) === key)) row.aliases.push(name.trim());
  }
}
function addVersions(row: CharacterRow, versions: VersionDraft[]): void {
  for (const version of versions) {
    const existing = row.versions.find(item => lower(item.name) === lower(version.name));
    if (!existing) row.versions.push({ ...version });
    else {
      if (existing.startingChapter === null) existing.startingChapter = version.startingChapter;
      if (!existing.description) existing.description = version.description;
    }
  }
}
function addSource(row: CharacterRow, source: string): void {
  if (!row.sources.includes(source)) row.sources.push(source);
}

export type MergeContext = { rows: CharacterRow[]; existing: ExistingKeyword[]; nextKey: () => string };

function findRow(context: MergeContext, names: string[]): CharacterRow | undefined {
  const keys = new Set(names.map(lower).filter(Boolean));
  return context.rows.find(row => rowNames(row).some(name => keys.has(lower(name))));
}

/** A table row for a keyword the novel already has, created the first time a page mentions it. */
function existingRow(context: MergeContext, names: string[]): CharacterRow | undefined {
  const keys = new Set(names.map(lower).filter(Boolean));
  const keyword = context.existing.find(item => [item.name, ...item.aliases.map(alias => alias.name)].some(name => keys.has(lower(decodeStoredText(name)))));
  if (!keyword) return undefined;
  const row = findRow(context, [decodeStoredText(keyword.name)]);
  if (row) return row;
  const names2 = [keyword.name, ...keyword.aliases.map(alias => alias.name)].map(decodeStoredText);
  const created: CharacterRow = {
    key: context.nextKey(), name: names2[0], description: "", aliases: names2.slice(1), versions: [], sources: [],
    keywordId: keyword.id, savedNames: names2.map(lower), savedChapters: keyword.versions.map(version => version.startingChapter),
    state: "idle", notes: ["Already in this novel; saving adds only new aliases and versions."],
  };
  context.rows.push(created);
  return created;
}

/** Moves an unsaved row into `target` when a page reveals they are the same character. */
function absorbDuplicates(context: MergeContext, target: CharacterRow): void {
  for (const other of [...context.rows]) {
    if (other === target || other.keywordId || other.state === "saving") continue;
    if (!target.aliases.some(alias => lower(alias) === lower(other.name))) continue;
    addAliases(target, other.aliases);
    addVersions(target, other.versions);
    for (const source of other.sources) addSource(target, source);
    if (!target.description) target.description = other.description;
    target.categoryId ??= other.categoryId;
    target.natureId ??= other.natureId;
    context.rows.splice(context.rows.indexOf(other), 1);
  }
}

function isOwnPage(pageTitle: string, names: string[]): boolean {
  const title = lower(pageTitle.replace(/\s*[|–—-]\s*.*(wiki|fandom).*$/i, ""));
  return names.some(name => lower(name) === title);
}

/**
 * Merges one phase's characters into the table and returns the rows they landed in.
 * A character the AI linked to a parent becomes that parent's alias or version.
 */
export function mergePageCharacters(context: MergeContext, characters: PageCharacter[], pageTitle: string): CharacterRow[] {
  const touched = new Set<CharacterRow>();
  for (const character of characters) {
    const names = [character.name, ...character.aliases];
    let target = findRow(context, names) ?? (character.parent ? undefined : existingRow(context, names));
    if (!target && character.parent) {
      const parent = findRow(context, [character.parent.name]) ?? existingRow(context, [character.parent.name]);
      if (parent) {
        if (character.parent.relation === "alias") addAliases(parent, names);
        else {
          addAliases(parent, character.aliases);
          addVersions(parent, [{ name: character.name, description: character.description, startingChapter: null }, ...character.versions]);
        }
        const note = `AI: “${character.name}” is probably ${character.parent.relation === "alias" ? "another name" : "a later form"} of ${parent.name}.`;
        if (!parent.notes.includes(note)) parent.notes.push(note);
        addSource(parent, pageTitle);
        absorbDuplicates(context, parent);
        if (parent.state === "saved" && hasPendingWork(parent)) parent.state = "idle";
        touched.add(parent);
        continue;
      }
      target = existingRow(context, names);
    }
    if (!target) {
      target = { key: context.nextKey(), name: character.name, description: "", aliases: [], versions: [], sources: [], savedNames: [], savedChapters: [], state: "idle", notes: [] };
      context.rows.push(target);
    }
    // The character's own page names it best; an unsaved row found through an alias takes that name.
    if (!target.keywordId && lower(target.name) !== lower(character.name) && isOwnPage(pageTitle, [character.name])) {
      const previous = target.name;
      target.name = character.name;
      target.aliases = target.aliases.filter(alias => lower(alias) !== lower(character.name));
      addAliases(target, [previous]);
    }
    const ownPage = isOwnPage(pageTitle, rowNames(target));
    if (character.description && (!target.description || ownPage)) target.description = character.description;
    if (character.categoryId && (!target.categoryId || ownPage)) target.categoryId = character.categoryId;
    if (character.natureId && (!target.natureId || ownPage)) target.natureId = character.natureId;
    addAliases(target, names);
    addVersions(target, character.versions);
    addSource(target, pageTitle);
    absorbDuplicates(context, target);
    if (target.state === "saved" && hasPendingWork(target)) target.state = "idle";
    touched.add(target);
  }
  return [...touched].filter(row => context.rows.includes(row));
}
