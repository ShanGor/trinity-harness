import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { modelPricingConfigSchema, type ModelPricing } from '@trinity-harness/contracts';
import { parseDocument } from 'yaml';

/** Load and validate the model price catalog from its fixed application config file. */
export function loadModelPricingConfig(configUrl: URL): ModelPricing {
  const configPath = fileURLToPath(configUrl);
  let source: string;
  try {
    source = readFileSync(configUrl, 'utf8');
  } catch (cause) {
    throw new Error(`Unable to read model pricing config at ${configPath}`, { cause });
  }

  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid model pricing YAML at ${configPath}: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }

  const parsed = modelPricingConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid model pricing config at ${configPath}: ${details}`);
  }
  return parsed.data.models;
}
