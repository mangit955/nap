/**
 * What the composer's model control offers: the free tier's model, when this caller has one, then
 * the nine model lines — one list, so every picker, label and image check reads the same thing.
 *
 * The id a turn names is a line key (`sol`) or the free model's exact id. A draft saved before
 * there were lines can hold an exact version (`openai/gpt-5.6-sol`); `choiceFor` reads that as its
 * line and drops anything this list does not know, so nothing stale is ever sent.
 */

import { modelSupportsImages } from "@nap/shared/model-capabilities";
import {
  type Effort,
  LineKeySchema,
  lineByKey,
  lineOf,
  type ModelVendor,
} from "@nap/shared/model-lines";
import type { ModelList } from "@nap/shared/models-protocol";

export type ModelOption = {
  /** What a turn names: a line key, or the free model's exact id. */
  id: string;
  label: string;
  /** Null for the free model, which belongs to no vendor's tab. */
  vendor: ModelVendor | null;
  /** The exact version a turn runs now; null when the line has none. */
  version: string | null;
  isNew: boolean;
  images: boolean;
  efforts: readonly Effort[];
  available: boolean;
  free: boolean;
};

export function modelOptions(list: ModelList | undefined): ModelOption[] {
  if (list === undefined) return [];
  const free: ModelOption[] =
    list.free === null
      ? []
      : [
          {
            id: list.free.id,
            label: list.free.label,
            vendor: null,
            version: list.free.id,
            isNew: false,
            images: list.free.images,
            // The deployment pays, so the deployment decides how hard it thinks.
            efforts: [],
            available: true,
            free: true,
          },
        ];
  return [
    ...free,
    ...list.lines.map((line) => ({
      id: line.key,
      label: line.label,
      vendor: line.vendor,
      version: line.version,
      isNew: line.isNew,
      images: line.images,
      efforts: line.efforts,
      available: line.available,
      free: false,
    })),
  ];
}

/**
 * The option a saved or chosen value names, or undefined for one this list does not know.
 *
 * A line key or the free model's id is itself; an exact version of a line is that line.
 */
export function choiceFor(
  options: readonly ModelOption[],
  model: string | undefined,
): ModelOption | undefined {
  if (model === undefined) return undefined;
  const exact = options.find((option) => option.id === model);
  if (exact !== undefined) return exact;
  const key = LineKeySchema.safeParse(model).success ? model : lineOf(model)?.key;
  return key === undefined ? undefined : options.find((option) => option.id === key);
}

/**
 * The option a message will run on: the one chosen, or else the server's default for this caller,
 * or else the first *reachable* one, so a caller never sees a locked line named as theirs. The
 * picker and the context popup both name it, and must not disagree.
 */
export function modelInUse(
  options: readonly ModelOption[],
  model: string | undefined,
): ModelOption | undefined {
  const chosen = choiceFor(options, model);
  if (chosen?.available === true) return chosen;
  return options.find((option) => option.available) ?? chosen ?? options[0];
}

/**
 * What a turn sends for `model`, and so what the composer must show: the option chosen when this
 * caller can run it, and otherwise nothing, so the server's default for them applies — which is
 * what the trigger then names. A choice that is not reachable any more, Sol after an Anthropic key
 * replaced an OpenRouter one, is dropped here rather than sent to be refused. Before the list has
 * loaded the value goes as it is: the server reads an exact version as its line too, and refuses
 * what it cannot place.
 */
export function sendableModel(
  options: readonly ModelOption[],
  model: string | undefined,
): string | undefined {
  if (options.length === 0) return model;
  const chosen = choiceFor(options, model);
  return chosen?.available === true ? chosen.id : undefined;
}

/**
 * Whether a turn on this choice may carry images. From the list when it has loaded; before then
 * from the line the value names, which the browser knows without asking.
 */
export function imagesFor(options: readonly ModelOption[], model: string | undefined): boolean {
  const option = options.length === 0 ? undefined : modelInUse(options, model);
  if (option !== undefined) return option.images;
  if (model === undefined) return false;
  const key = LineKeySchema.safeParse(model);
  return key.success ? lineByKey(key.data).images : modelSupportsImages(model);
}
