import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription, PageLastUpdate } from 'fumadocs-ui/page';
import { getGithubLastEdit } from 'fumadocs-core/content/github';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const lastModifiedTime = process.env.NODE_ENV === 'development'? null : await getGithubLastEdit({
    owner: 'paambaati',
    repo: 'terrably',
    path: `docs/${page.path}`,
  });

  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
      {lastModifiedTime && <PageLastUpdate date={lastModifiedTime} />}
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
