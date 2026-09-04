"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { cronLabel } from "@/lib/bot-template";
import type { BotTemplate } from "@/lib/seat";

/**
 * What is actually in a template, in full.
 *
 * Everything here is shown rather than summarised, and that is the point of
 * the screen rather than a preference about density: installing a template
 * puts its instructions into a Bot's system prompt and its skills onto the
 * computer, so "Add Bot" is consent, and consent to something you were not
 * shown is not consent. It is used twice: by the person publishing, to see
 * what they are about to hand out, and by the person receiving, to see what
 * they are about to run.
 *
 * The text is rendered as text, never as markdown. A template is written by a
 * stranger's Bot, and a link or an image in it would be a stranger's link on a
 * page a person is reading in order to trust them.
 */
export function TemplateDetail({ template }: { template: BotTemplate }): React.ReactElement {
  const sections: { body: React.ReactNode; count: number; id: string; label: string }[] = [
    {
      body: <Prose text={template.instructions} />,
      count: template.instructions ? 1 : 0,
      id: "instructions",
      label: "Instructions",
    },
    {
      body: (
        <ul className="flex flex-col gap-1.5">
          {template.memories.map((fact) => (
            <li className="text-muted-foreground text-sm" key={fact}>
              {fact}
            </li>
          ))}
        </ul>
      ),
      count: template.memories.length,
      id: "memories",
      label: "Memories",
    },
    {
      body: (
        <ul className="flex flex-col gap-3">
          {template.skills.map((skill) => (
            <li key={skill.id}>
              <p className="font-medium text-sm">{skill.name}</p>
              {skill.use_when && <p className="text-muted-foreground text-xs">{skill.use_when}</p>}
            </li>
          ))}
        </ul>
      ),
      count: template.skills.length,
      id: "skills",
      label: "Skills",
    },
    {
      body: (
        <ul className="flex flex-col gap-3">
          {template.routines.map((routine) => (
            <li key={routine.id}>
              <p className="font-medium text-sm">{routine.title}</p>
              <p className="text-muted-foreground text-xs">
                {cronLabel(routine.cron)}
                {" · "}
                {/* Honest rather than flattering. A Bot made from a template
                    runs the template Eve project, which compiles no schedules,
                    so a routine that arrives this way is recorded and shown
                    and does not fire until you say so. */}
                Paused until you start it
              </p>
            </li>
          ))}
        </ul>
      ),
      count: template.routines.length,
      id: "routines",
      label: "Routines",
    },
    {
      body: (
        <ul className="flex flex-col gap-3">
          {template.plugins.map((plugin) => (
            <li className="flex items-center gap-2" key={plugin.name}>
              <span className="font-medium text-sm">{plugin.name}</span>
              <Badge variant="outline">{plugin.auth === "oauth" ? "Sign-in" : "Needs a key"}</Badge>
            </li>
          ))}
        </ul>
      ),
      count: template.plugins.length,
      id: "plugins",
      label: "Plugins",
    },
  ];

  return (
    <Accordion className="flex flex-col gap-2" collapsible type="single">
      {sections.map((section) => (
        <AccordionItem
          className="rounded-xl border border-border bg-card px-4"
          key={section.id}
          value={section.id}
        >
          <AccordionTrigger className="py-3 text-left" disabled={section.count === 0}>
            <span className="flex w-full items-center gap-3">
              <span className="font-medium text-sm">{section.label}</span>
              <span className="ml-auto text-muted-foreground text-xs">
                {section.count === 0 ? "None" : section.count}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-4">{section.body}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

/** Whitespace kept, markup not. A brief is paragraphs, not a document to run. */
function Prose({ text }: { text: string }): React.ReactElement {
  return <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">{text}</p>;
}
