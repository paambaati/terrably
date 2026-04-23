import defaultMdxComponents from 'fumadocs-ui/mdx';
import * as TabsComponents from 'fumadocs-ui/components/tabs';
import * as StepsComponents from 'fumadocs-ui/components/steps';
import * as FilesComponents from 'fumadocs-ui/components/files';
import * as AccordionComponents from 'fumadocs-ui/components/accordion';
import * as CardComponents from 'fumadocs-ui/components/card';
import { BookOpenIcon, RocketIcon, UploadIcon, WrenchIcon } from 'lucide-react';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import * as Twoslash from 'fumadocs-twoslash/ui';
import { createGenerator, createFileSystemGeneratorCache } from 'fumadocs-typescript';
import { AutoTypeTable } from 'fumadocs-typescript/ui';
import type { AutoTypeTableProps } from 'fumadocs-typescript/ui';
import type { MDXComponents } from 'mdx/types';

const generator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/fumadocs-typescript'),
});

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...TabsComponents,
    ...StepsComponents,
    ...AccordionComponents,
    ...CardComponents,
    BookOpenIcon, RocketIcon, UploadIcon, WrenchIcon,
    // Must come after icon imports — lucide exports Files + Folder icons that
    // would otherwise shadow fumadocs' file-tree components.
    ...FilesComponents,
    TypeTable,
    ...Twoslash,
    AutoTypeTable: (props: Partial<AutoTypeTableProps>) => <AutoTypeTable {...props as AutoTypeTableProps} generator={generator} />,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
