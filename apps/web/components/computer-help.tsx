"use client";

import {
  ArrowUpDownIcon,
  ClipboardIcon,
  Hand5FingerIcon,
  KeyboardIcon,
  MouseIcon,
  MousePointerClickIcon,
  SquareCursorIcon,
  ZoomInIcon,
} from "blode-icons-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * What the gestures are, in the words the removed iOS client used.
 *
 * None of this is discoverable: a two-finger tap for the right button and a
 * pinch that magnifies the desk rather than the page are conventions, not
 * affordances, and the desk is the one surface in the product where guessing
 * wrong presses something on a real computer. So it is written down, reachable
 * from the desk itself, and worded the same as on the phone so a person who
 * has used one already knows this one.
 */
interface Gesture {
  icon: React.ElementType;
  name: string;
  how: string;
}

function gestures(readable: boolean): { title: string; items: Gesture[] }[] {
  return [
    {
      items: [
        { how: "Drag with two fingers.", icon: ArrowUpDownIcon, name: "Scroll" },
        {
          how: "Tap to click where you tapped. One finger drags.",
          icon: MousePointerClickIcon,
          name: "Click and drag",
        },
        {
          how: "Tap with two fingers, or press and hold.",
          icon: MouseIcon,
          name: "Right-click",
        },
        {
          how: "Pinch to zoom. Zoomed in, two fingers pan instead of scrolling.",
          icon: ZoomInIcon,
          name: "Zoom in",
        },
      ],
      title: "Moving around",
    },
    {
      items: [
        { how: "Tap the keyboard button in the bottom bar.", icon: KeyboardIcon, name: "Type" },
        {
          how: readable
            ? "Tap the clipboard button in the bottom bar to read what the computer copied, or send it something."
            : "Tap the clipboard button in the bottom bar and send it what you copied here.",
          icon: ClipboardIcon,
          name: "Copy and paste",
        },
      ],
      title: "Typing and the clipboard",
    },
    {
      items: [
        {
          how: "Turn it on from the ⋯ menu. Your finger moves the pointer; tap to click there, double-tap and hold to drag. Recenter the pointer if it drifts.",
          icon: SquareCursorIcon,
          name: "Trackpad mode",
        },
      ],
      title: "When a pointer is easier",
    },
    {
      items: [
        {
          how: "Tap I’m done and it picks up where you left off. Everything you do here happens on a computer it shares, so what you sign into stays signed in.",
          icon: Hand5FingerIcon,
          name: "Handing it back",
        },
      ],
      title: "Handing it back",
    },
  ];
}

export function ComputerHelp({
  onOpenChange,
  open,
  readable = true,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** A guest seat may paste in and never read out, so the clipboard line changes. */
  readable?: boolean;
}): React.ReactElement {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85svh] gap-0 overflow-y-auto p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Using the computer</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5 px-5 pb-6">
          {gestures(readable).map((section) => (
            <section className="flex flex-col gap-2" key={section.title}>
              <h3 className="font-medium text-muted-foreground text-xs">{section.title}</h3>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {section.items.map((item) => (
                  <li className="flex gap-3 p-3" key={item.name}>
                    <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{item.name}</p>
                      <p className="text-muted-foreground text-sm leading-6">{item.how}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
