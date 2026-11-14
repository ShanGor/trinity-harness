import type { BrowserObservation } from '@trinity-harness/contracts';

const escape = (text: string): string => text.replace(/[\\`*_[\]<>#]/g, '\\$&');
/** Converts immutable evidence only; never fetches URLs or asserts complete coverage. */
export function browserMarkdown(observation: BrowserObservation): {
  markdown: string;
  summary: {
    images: number;
    imageDelivery: 'embedded' | 'mixed' | 'remote-references';
    coverage: 'unverified';
  };
} {
  let images = 0,
    embedded = 0;
  const blocks = observation.blocks.map((block): string => {
    if (block.image) {
      images++;
      if (block.image.data) embedded++;
      return `![${escape(block.image.alt)}](<${(block.image.data ?? block.image.url).replace(/>/g, '%3E')}>)`;
    }
    if (block.kind === 'heading') return `${'#'.repeat(block.level ?? 2)} ${escape(block.text)}`;
    if (block.kind === 'code') {
      const fence = '`'.repeat(
        Math.max(3, ...Array.from(block.text.matchAll(/`+/g), (m) => m[0].length + 1)),
      );
      return `${fence}\n${block.text}\n${fence}`;
    }
    if (block.kind === 'table' && block.rows?.length) {
      const rows = block.rows.map((row) =>
        row.map((cell) => escape(cell.text).replace(/\|/g, '\\|').replace(/\n/g, '<br>')),
      );
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]): string =>
        `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
      return [
        line(rows[0]!),
        line(Array<string>(width).fill('---')),
        ...rows.slice(1).map(line),
      ].join('\n');
    }
    const text = escape(block.text);
    const links = block.links
      .map((link) => `[${escape(link.title)}](<${link.url.replace(/>/g, '%3E')}>)`)
      .join(' · ');
    return `${block.kind === 'list_item' ? '  '.repeat(block.listDepth ?? 0) + (block.ordinal !== undefined ? block.ordinal + '. ' : '- ') : ''}${text}${links ? `\n\n${links}` : ''}`;
  });
  const coverage =
    observation.captureTruncated || observation.readiness !== 'ready'
      ? 'Partial capture.'
      : 'Coverage has not been independently verified.';
  return {
    markdown: `# ${escape(observation.title)}\n\nSource: <${observation.url}>\n\nCaptured: ${observation.capturedAt}\n\nRepresentation: ${observation.extractorVersion === 'rendered-v1' ? 'saved policy-filtered rendered documents' : 'saved semantic observation (original HTML unavailable)'}.\n\n${coverage} Images embedded from decoded browser pixels where available; remaining images use original remote URLs.\n\n${blocks.join('\n\n')}\n`,
    summary: {
      images,
      imageDelivery:
        images > 0 && embedded === images
          ? 'embedded'
          : embedded > 0
            ? 'mixed'
            : 'remote-references',
      coverage: 'unverified',
    },
  };
}
