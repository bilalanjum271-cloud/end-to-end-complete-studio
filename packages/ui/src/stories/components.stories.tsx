import type { Meta, StoryObj } from '@storybook/react';
import { Film, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, CommandPalette, Dialog, Drawer, EmptyState, Input, Progress, Select, Skeleton, StatusBadge, Table, Tabs, Textarea, Tooltip, useToast } from '../index';

const meta: Meta = { title: 'Components' };
export default meta;
type Story = StoryObj;

export const Buttons: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="generate" size="lg" icon={<Sparkles className="size-4" aria-hidden />}>Generate video</Button>
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" icon={<Trash2 className="size-4" aria-hidden />}>Delete</Button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button size="sm">Small</Button><Button size="md">Medium</Button><Button size="lg">Large</Button>
        <Button loading>Saving</Button><Button disabled>Disabled</Button>
      </div>
    </div>
  ),
};

export const Fields: Story = {
  render: () => (
    <div className="grid max-w-md gap-6">
      <Input label="Email" type="email" placeholder="you@studio.com" autoComplete="email" />
      <Input label="Password" type="password" error="Use at least 10 characters." defaultValue="short" />
      <Textarea label="Prompt" hint="Describe the video you want. You approve the script before anything renders." />
      <Select label="Narration language" placeholder="Choose a language"
        options={[{ value: 'en', label: 'English' }, { value: 'ur', label: 'Urdu' }, { value: 'ar', label: 'Arabic' }, { value: 'es', label: 'Spanish' }]} />
    </div>
  ),
};

function Overlays() {
  const toast = useToast();
  const [palette, setPalette] = useState(false);
  return (
    <div className="flex flex-wrap gap-4">
      <Dialog trigger={<Button>Open dialog</Button>} title="Discard this draft?" description="The script and its scenes will be removed. You can undo for the next few seconds."
        footer={<><Button variant="ghost">Cancel</Button><Button variant="danger">Discard</Button></>} />
      <Drawer trigger={<Button>Open drawer</Button>} title="Scene 3" description="Adjust narration and visuals for this scene.">
        <Textarea label="Narration" defaultValue="In 1908, something flattened 2,000 square kilometres of Siberian forest." />
      </Drawer>
      <Button onClick={() => toast({ title: 'Scene deleted', tone: 'info', action: { label: 'Undo', onClick: () => toast({ title: 'Scene restored', tone: 'success' }) } })}>Toast with undo</Button>
      <Tooltip content="Open the command palette"><Button variant="ghost" onClick={() => setPalette(true)}>Command palette</Button></Tooltip>
      <CommandPalette open={palette} onOpenChange={setPalette} items={[
        { id: 'new', label: 'New video', group: 'Create', icon: <Plus className="size-4" />, shortcut: 'N', onSelect: () => undefined },
        { id: 'video', label: 'Go to Script-to-Video', group: 'Navigate', icon: <Film className="size-4" />, shortcut: 'G V', onSelect: () => undefined },
      ]} />
    </div>
  );
}
export const OverlaysAndToasts: Story = { render: () => <Overlays /> };

export const DataAndStatus: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap gap-2">
        <StatusBadge status="queued" label="Queued" /><StatusBadge status="running" label="Rendering" /><StatusBadge status="review" label="In review" />
        <StatusBadge status="succeeded" label="Ready" /><StatusBadge status="failed" label="Failed" /><StatusBadge status="draft" label="Draft" />
      </div>
      <div className="grid max-w-md gap-4">
        <Progress label="Scene 2 of 6 · visuals" value={42} detail="00:38 left · 18 credits" />
        <Skeleton className="h-40 w-full" /><Skeleton className="h-4 w-2/3" />
      </div>
      <Table caption="Credit ledger" rowKey={(r) => r.id}
        rows={[{ id: '1', type: 'Reserve', job: 'video-7f3a', amount: '-120' }, { id: '2', type: 'Refund', job: 'video-7f3a', amount: '+120' }]}
        columns={[{ key: 'type', header: 'Type', cell: (r) => r.type }, { key: 'job', header: 'Job', cell: (r) => r.job, mono: true }, { key: 'amount', header: 'Credits', cell: (r) => r.amount, align: 'end', mono: true }]} />
      <Tabs label="Project sections" items={[{ value: 'script', label: 'Script', content: 'Script editor' }, { value: 'scenes', label: 'Scenes', content: 'Scene list' }, { value: 'review', label: 'Review', content: 'Review player' }]} />
      <EmptyState icon={<Film className="size-6" aria-hidden />} title="No videos yet" description="Write a prompt and approve the script. Your first video takes about two minutes."
        action={<Button variant="generate" icon={<Sparkles className="size-4" aria-hidden />}>Create your first video</Button>} />
    </div>
  ),
};
