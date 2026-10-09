import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentRef,
  type ReactElement,
} from 'react';
import { Input } from 'antd';
import { layout, prepare } from '@chenglou/pretext';

type TextAreaProps = ComponentProps<typeof Input.TextArea>;
type Dimensions = {
  width: number;
  font: string;
  lineHeight: number;
  extraHeight: number;
};

export const PretextTextArea = forwardRef<ComponentRef<typeof Input.TextArea>, TextAreaProps>(
  function PretextTextArea({ value, autoSize, style, ...props }, forwardedRef): ReactElement {
    const inputRef = useRef<ComponentRef<typeof Input.TextArea> | null>(null);
    const [dimensions, setDimensions] = useState<Dimensions | null>(null);
    const minRows = typeof autoSize === 'object' ? (autoSize.minRows ?? 1) : 1;
    const maxRows = typeof autoSize === 'object' ? (autoSize.maxRows ?? 8) : 8;
    const setRef = useCallback(
      (node: ComponentRef<typeof Input.TextArea> | null) => {
        inputRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    useLayoutEffect(() => {
      const textarea = inputRef.current?.resizableTextArea?.textArea;
      if (!textarea) return;
      let previousWidth = -1;
      const measure = (): void => {
        const width = textarea.getBoundingClientRect().width;
        // Ignore notifications caused only by our own height update.
        if (width <= 0 || width === previousWidth) return;
        previousWidth = width;
        const css = window.getComputedStyle(textarea);
        const px = (value: string): number => Number.parseFloat(value) || 0;
        const paddingX = px(css.paddingLeft) + px(css.paddingRight);
        const borderX = px(css.borderLeftWidth) + px(css.borderRightWidth);
        const paddingY = px(css.paddingTop) + px(css.paddingBottom);
        const borderY = px(css.borderTopWidth) + px(css.borderBottomWidth);
        setDimensions({
          width: Math.max(1, width - paddingX - borderX),
          font: `${css.fontStyle || 'normal'} ${css.fontWeight || '400'} ${css.fontSize || '16px'} ${css.fontFamily || 'sans-serif'}`,
          lineHeight: px(css.lineHeight) || (px(css.fontSize) || 16) * 1.5,
          extraHeight: css.boxSizing === 'border-box' ? paddingY + borderY : 0,
        });
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(textarea);
      return () => observer.disconnect();
    }, []);

    const font = dimensions?.font;
    const text = String(value ?? '');
    const prepared = useMemo(
      () =>
        font
          ? prepare(!text || text.endsWith('\n') ? `${text} ` : text, font, {
              whiteSpace: 'pre-wrap',
            })
          : null,
      [text, font],
    );
    const textHeight =
      dimensions && prepared
        ? layout(prepared, dimensions.width, dimensions.lineHeight).height
        : undefined;
    const height =
      dimensions && textHeight !== undefined
        ? Math.min(
            Math.max(textHeight, minRows * dimensions.lineHeight),
            maxRows * dimensions.lineHeight,
          ) + dimensions.extraHeight
        : undefined;

    return (
      <Input.TextArea
        {...props}
        ref={setRef}
        value={value}
        rows={minRows}
        autoSize={false}
        style={{
          ...style,
          height,
          resize: 'none',
          overflowY:
            dimensions && textHeight !== undefined && textHeight > maxRows * dimensions.lineHeight
              ? 'auto'
              : 'hidden',
        }}
      />
    );
  },
);
