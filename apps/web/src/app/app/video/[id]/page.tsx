import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Project } from '@/lib/projects';
import { ApiError, accessToken, gw, prefs } from '@/lib/server';
import { ProjectView } from './project-view';

export const metadata: Metadata = { title: 'Video' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await prefs();
  let project: Project;
  try {
    project = await gw<Project>(`/v1/projects/${id}`, { token: await accessToken() });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/video" className="inline-flex w-fit items-center gap-2 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />{t('project.back')}
      </Link>
      <ProjectView initial={project} />
    </div>
  );
}
