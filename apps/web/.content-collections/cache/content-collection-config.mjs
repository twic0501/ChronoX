// content-collections.ts
import { defineCollection, defineConfig } from "@content-collections/core";
import { z } from "zod";
var changelog = defineCollection({
  name: "changelog",
  directory: "content/changelog",
  include: "*.md",
  schema: z.object({
    content: z.string(),
    version: z.string(),
    date: z.string(),
    title: z.string(),
    description: z.string().optional(),
    changes: z.array(
      z.object({
        type: z.string(),
        text: z.string()
      })
    )
  }),
  transform: async (doc, { collection }) => {
    const allDocs = await collection.documents();
    const sorted = [...allDocs].sort(
      (a, b) => b.version.localeCompare(a.version, void 0, { numeric: true })
    );
    const isLatest = sorted[0]?.version === doc.version;
    return { ...doc, isLatest };
  }
});
var content_collections_default = defineConfig({
  content: [changelog]
});
export {
  content_collections_default as default
};
