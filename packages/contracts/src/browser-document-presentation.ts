import { z } from 'zod';

/** Closed presentation vocabulary: no URLs, custom properties, selectors or executable CSS. */
export const BROWSER_PRESENTATION_PROPERTIES = [
  'color',
  'background-color',
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant-numeric',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'white-space',
  'overflow-wrap',
  'word-break',
  'overflow-x',
  'overflow-y',
  'text-overflow',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'justify-content',
  'justify-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'list-style-type',
  'opacity',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'fill-rule',
  'fill-opacity',
  'stroke-opacity',
] as const;
// Reject escapes and CSS delimiters; only the listed numeric/color/layout functions are allowed.
export const BROWSER_PRESENTATION_VALUE = '^[a-zA-Z0-9 #.,%()+/"\'_-]+$';
export const BROWSER_PRESENTATION_FUNCTION =
  '\\b(?!rgb\\(|rgba\\(|hsl\\(|hsla\\(|calc\\(|min\\(|max\\(|clamp\\(|repeat\\(|minmax\\(|fit-content\\()[a-zA-Z_-]+\\(';
export const BROWSER_VECTOR_TAGS = [
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'svg-text',
  'tspan',
] as const;
const numberList = '^[0-9eE+.,% \\-]+$';
const paint =
  '^(?:none|currentColor|transparent|[a-zA-Z]+|#[a-fA-F0-9]{3,8}|rgba?\\([0-9.,% ]+\\))$';
export const BROWSER_VECTOR_ATTRIBUTES = {
  viewBox: numberList,
  width: numberList,
  height: numberList,
  x: numberList,
  y: numberList,
  x1: numberList,
  y1: numberList,
  x2: numberList,
  y2: numberList,
  cx: numberList,
  cy: numberList,
  r: numberList,
  rx: numberList,
  ry: numberList,
  d: '^[MmZzLlHhVvCcSsQqTtAa0-9eE+., \\-]+$',
  points: numberList,
  transform: '^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\\([0-9eE+., \\-]+\\)[ ,]*)+$',
  fill: paint,
  stroke: paint,
  'stroke-width': numberList,
  'stroke-dasharray': '^(?:none|[0-9.,% \\-]+)$',
  'stroke-linecap': '^(?:butt|round|square)$',
  'stroke-linejoin': '^(?:miter|round|bevel)$',
  'fill-rule': '^(?:nonzero|evenodd)$',
  'fill-opacity': numberList,
  'stroke-opacity': numberList,
  opacity: numberList,
  'text-anchor': '^(?:start|middle|end)$',
  preserveAspectRatio: '^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$',
} as const;
export const browserPresentationSchema = z.partialRecord(
  z.enum(BROWSER_PRESENTATION_PROPERTIES),
  z
    .string()
    .max(512)
    .regex(new RegExp(BROWSER_PRESENTATION_VALUE))
    .refine((value) => !new RegExp(BROWSER_PRESENTATION_FUNCTION, 'i').test(value)),
);
export const browserVectorAttributesSchema = z
  .record(z.string(), z.string().max(16000))
  .refine((attrs) =>
    Object.entries(attrs).every(([name, value]) => {
      const pattern = BROWSER_VECTOR_ATTRIBUTES[name as keyof typeof BROWSER_VECTOR_ATTRIBUTES];
      return (
        Object.hasOwn(BROWSER_VECTOR_ATTRIBUTES, name) &&
        pattern !== undefined &&
        new RegExp(pattern).test(value)
      );
    }),
  );
