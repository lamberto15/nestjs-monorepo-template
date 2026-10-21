import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card';

const meta = {
  title: 'Components/Card',
  component: Card,
  argTypes: { size: { control: 'select', options: ['default', 'sm'] } },
  render: (args) => (
    <Card {...args} className="max-w-sm">
      <CardHeader>
        <CardTitle>Notes</CardTitle>
        <CardDescription>Everything your team wrote down.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button>Open</Button>
      </CardContent>
    </Card>
  ),
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Small: Story = { args: { size: 'sm' } };
