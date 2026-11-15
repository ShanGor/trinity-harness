import type { ReactElement } from 'react';
import { Button, Dropdown, message, type MenuProps } from 'antd';
import { CopyOutlined, MoreOutlined } from '@ant-design/icons';

/** Keep diagnostic paths out of the browsing layout, but available on demand. */
export function WorkspaceMoreMenu({
  absolutePath,
  items = [],
}: {
  absolutePath?: string;
  items?: MenuProps['items'];
}): ReactElement {
  const [feedback, contextHolder] = message.useMessage();
  return (
    <>
      {contextHolder}
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        menu={{
          items: [
            ...items,
            ...(items.length ? [{ type: 'divider' as const }] : []),
            {
              key: 'copy-path',
              label: 'Copy absolute path',
              icon: <CopyOutlined />,
              disabled: !absolutePath,
              onClick: () => {
                if (!absolutePath) return;
                void (async (): Promise<void> => {
                  try {
                    await navigator.clipboard.writeText(absolutePath);
                    void feedback.success('Absolute path copied');
                  } catch {
                    void feedback.error(
                      'Could not copy the path. Clipboard access is unavailable.',
                    );
                  }
                })();
              },
            },
          ],
        }}
      >
        <Button type="text" icon={<MoreOutlined />} aria-label="More workspace actions" />
      </Dropdown>
    </>
  );
}
