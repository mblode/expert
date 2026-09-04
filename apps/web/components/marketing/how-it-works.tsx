"use client";
"use no memo";

import {
  Checkmark1Icon,
  CircleCheckIcon,
  ConsoleIcon,
  GlobeIcon,
  Hand5FingerIcon,
  LightningIcon,
  LockIcon,
  ShareScreenIcon,
  SparkleIcon,
  WhatsappIcon,
} from "blode-icons-react";
import type { MotionValue } from "motion/react";
import { motion, useScroll, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { siteConfig } from "@/lib/config";
import { howItWorks } from "@/lib/content";
import { cn } from "@/lib/utils";

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    // ResizeObserver fires once on observe, so the first callback is the
    // initial measurement: reading the width here as well would be a
    // synchronous setState in an effect for a value arriving a tick later.
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        setIsMobile(entry.contentRect.width < 640);
      }
    });
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return isMobile;
};

const TweenElement = ({
  scrollYProgress: p,
  kf,
  className,
  children,
}: {
  scrollYProgress: MotionValue<number>;
  kf: { p: number[]; x: number[]; y: number[]; s: number[]; o: number[]; r?: number[] };
  className?: string;
  children: React.ReactNode;
}) => {
  const x = useTransform(p, kf.p, kf.x);
  const y = useTransform(p, kf.p, kf.y);
  const scale = useTransform(p, kf.p, kf.s);
  const opacity = useTransform(p, [0, ...kf.p, 1], [0, ...kf.o, kf.o.at(-1) ?? 0]);
  const rotate = useTransform(p, kf.p, kf.r ?? kf.p.map(() => 0));

  return (
    <motion.div
      className={cn("absolute top-1/2 left-1/2", className)}
      style={{ opacity, rotate, scale, x, y }}
    >
      {children}
    </motion.div>
  );
};

const StepGroup = ({
  scrollYProgress: p,
  range,
  step,
  title,
  description,
  persist = false,
  children,
}: {
  scrollYProgress: MotionValue<number>;
  range: [number, number, number, number];
  step: string;
  title: string;
  description: string;
  persist?: boolean;
  children: React.ReactNode;
}) => {
  const [enterStart, enterEnd, exitStart, exitEnd] = range;
  const opacity = useTransform(
    p,
    [enterStart, enterEnd, exitStart, exitEnd],
    persist ? [0, 1, 1, 1] : [0, 1, 1, 0],
  );
  const y = useTransform(
    p,
    [enterStart, enterEnd, exitStart, exitEnd],
    persist ? [30, 0, 0, 0] : [30, 0, 0, -30],
  );
  const scale = useTransform(
    p,
    [enterStart, enterEnd, exitStart, exitEnd],
    persist ? [0.97, 1, 1, 1] : [0.97, 1, 1, 0.97],
  );

  return (
    <motion.div
      className="absolute inset-0 flex flex-col justify-center px-4 sm:px-6"
      style={{ opacity, scale, y }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:gap-12">
        <div className="shrink-0 sm:w-1/2">
          <span className="font-mono text-[0.625rem] text-growth-green/70 sm:text-xs">{step}</span>
          <h3 className="mt-1 font-semibold text-foreground text-lg sm:text-xl md:text-3xl">
            {title}
          </h3>
          <p className="mt-1 max-w-[28ch] text-[0.8125rem]/5 text-muted-foreground sm:mt-2 sm:max-w-[38ch] sm:text-base/7">
            {description}
          </p>
        </div>
        <div className="w-full min-w-0 sm:flex-1">{children}</div>
      </div>
    </motion.div>
  );
};

const StaggerChild = ({
  scrollYProgress: p,
  range,
  persist = false,
  className,
  children,
}: {
  scrollYProgress: MotionValue<number>;
  range: [number, number, number, number];
  persist?: boolean;
  className?: string;
  children: React.ReactNode;
}) => {
  const opacity = useTransform(p, range, persist ? [0, 1, 1, 1] : [0, 1, 1, 0]);
  const y = useTransform(p, range, [12, 0, 0, 0]);

  return (
    <motion.div className={className} style={{ opacity, y }}>
      {children}
    </motion.div>
  );
};

/** A digit repeats, so the box is keyed by where it sits rather than by what it shows. */
const CODE_DIGITS = ["4", "1", "9", "2", "0", "7"].map((digit, position) => ({ digit, position }));

/**
 * The sign-in card, revealed a line at a time. Six digits and no password is
 * the whole of the onboarding, so the mock is allowed to be the real thing
 * rather than a stand-in for a longer flow.
 */
const SignInCard = ({ scrollYProgress: p }: { scrollYProgress: MotionValue<number> }) => {
  const email = useTransform(p, [0.1, 0.12], [0, 1]);
  const codeLabel = useTransform(p, [0.13, 0.15], [0, 1]);
  const digits = useTransform(p, [0.15, 0.17], [0, 1]);
  const done = useTransform(p, [0.17, 0.185], [0, 1]);

  return (
    <div className="max-w-[420px] space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:px-5 sm:py-5">
      <motion.div className="flex items-center gap-2" style={{ opacity: email }}>
        <LockIcon className="size-4 shrink-0 text-growth-green" />
        <span className="font-mono text-white/60 text-xs uppercase tracking-wider">
          hello.expert
        </span>
      </motion.div>

      <motion.div
        className="rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2.5 text-sm text-white/80 sm:px-4"
        style={{ opacity: email }}
      >
        you@example.com
      </motion.div>

      <motion.div className="text-white/60 text-xs" style={{ opacity: codeLabel }}>
        We sent a six digit code.
      </motion.div>

      <motion.div className="flex gap-1.5 sm:gap-2" style={{ opacity: digits }}>
        {CODE_DIGITS.map((slot) => (
          <div
            className="flex size-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] font-mono text-sm text-white/80 tabular-nums sm:size-11 sm:text-base"
            key={slot.position}
          >
            {slot.digit}
          </div>
        ))}
      </motion.div>

      <motion.div
        className="flex items-center gap-2.5 text-growth-green text-xs drop-shadow-[0_0_8px_rgba(73,222,128,0.3)] sm:text-sm"
        style={{ opacity: done }}
      >
        <Checkmark1Icon className="size-4 shrink-0" />
        <span>Signed in. Your computer is already running.</span>
      </motion.div>
    </div>
  );
};

export const HowItWorksSection = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const [trailBox, setTrailBox] = useState({ h: 100, w: 785 });
  const isMobile = useIsMobile();
  const { scrollYProgress } = useScroll({ offset: ["start start", "end end"], target: sectionRef });

  useEffect(() => {
    const el = trailRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setTrailBox({ h: height, w: width });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trailR = Math.max(0, trailBox.h / 2 - 1.5);
  const tw = trailBox.w;
  const th = trailBox.h;
  const trailPath = `M${tw / 2},1.5 L${tw - trailR - 1.5},1.5 A${trailR},${trailR},0,0,1,${tw - 1.5},${th / 2} A${trailR},${trailR},0,0,1,${tw - trailR - 1.5},${th - 1.5} L${trailR + 1.5},${th - 1.5} A${trailR},${trailR},0,0,1,1.5,${th / 2} A${trailR},${trailR},0,0,1,${trailR + 1.5},1.5 Z`;

  const bgOpacity = useTransform(scrollYProgress, [0.04, 0.1], [0, 1]);

  const trailDashOffset = useTransform(scrollYProgress, [0, 0.03], [1, 0]);
  const trailOpacity = useTransform(scrollYProgress, [0, 0.001, 0.035, 0.045], [0, 1, 1, 0]);
  const startBgOpacity = useTransform(scrollYProgress, [0.03, 0.04, 0.06, 0.1], [0, 1, 1, 0]);
  const startTextOpacity = useTransform(scrollYProgress, [0.035, 0.05, 0.06, 0.09], [0, 1, 1, 0]);

  return (
    <section className="relative" ref={sectionRef} style={{ height: isMobile ? "600vh" : "500vh" }}>
      <div className="sticky top-0 h-svh overflow-hidden">
        <div
          className={cn(
            "pointer-events-none absolute top-[46%] z-30 h-[8%]",
            isMobile ? "left-[15%] w-[70%]" : "left-[25%] w-[50%]",
          )}
          ref={trailRef}
        >
          <motion.svg
            className="absolute inset-0 size-full"
            fill="none"
            style={{ opacity: trailOpacity }}
            viewBox={`0 0 ${tw} ${th}`}
          >
            <motion.path
              d={trailPath}
              fill="none"
              pathLength={1}
              stroke="white"
              strokeDasharray="1"
              strokeLinecap="round"
              strokeWidth="3"
              style={{ strokeDashoffset: trailDashOffset }}
            />
          </motion.svg>
        </div>

        <motion.div
          className="absolute inset-0 z-10 bg-background"
          style={{ opacity: bgOpacity }}
        />

        <motion.div
          className="pointer-events-none absolute top-[46%] right-[15%] bottom-[46%] left-[15%] z-20 flex items-center justify-center overflow-hidden rounded-[200px] bg-white sm:right-[25%] sm:left-[25%]"
          style={{ opacity: startBgOpacity }}
        >
          <motion.span
            className="flex items-center gap-2 font-semibold text-[#0a0a0a] text-sm sm:text-base"
            style={{ opacity: startTextOpacity }}
          >
            Get started
            <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
              <path
                d="M3.5 10.5L10.5 3.5M10.5 3.5H5M10.5 3.5V9"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </motion.span>
        </motion.div>

        <div className="absolute inset-0 z-10">
          <div className="absolute inset-x-0 top-20 z-10 px-4 text-center sm:top-[7%] sm:px-6">
            <TweenElement
              className="static"
              kf={{
                o: [0, 1, 1, 1],
                p: [0.12, 0.16, 0.88, 0.92],
                s: [0.95, 1, 1, 1],
                x: [0, 0, 0, 0],
                y: [-10, 0, 0, 0],
              }}
              scrollYProgress={scrollYProgress}
            >
              <span className="text-balance font-display font-light text-3xl tracking-tight sm:text-4xl sm:tracking-[-0.02em]">
                How it works
              </span>
            </TweenElement>
          </div>

          {/* Step 1: an email code, and the computer is already up */}
          <StepGroup
            description={howItWorks[0].body}
            range={[0.1, 0.15, 0.19, 0.23]}
            scrollYProgress={scrollYProgress}
            step={howItWorks[0].step}
            title={howItWorks[0].title}
          >
            <SignInCard scrollYProgress={scrollYProgress} />
          </StepGroup>

          {/* Step 2: ask for something, watch it drive the browser */}
          <StepGroup
            description={howItWorks[1].body}
            range={[0.27, 0.33, 0.46, 0.51]}
            scrollYProgress={scrollYProgress}
            step={howItWorks[1].step}
            title={howItWorks[1].title}
          >
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <SparkleIcon className="size-4 shrink-0 text-growth-green" />
                <span className="whitespace-nowrap font-medium text-sm text-white">
                  Your computer
                </span>
              </div>

              <StaggerChild range={[0.27, 0.33, 0.46, 0.5]} scrollYProgress={scrollYProgress}>
                <div className="flex gap-3">
                  <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-medium text-white/60 text-xs sm:size-8">
                    H
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/[0.06] bg-white/[0.06] px-4 py-3 text-[0.8125rem]/5 text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:px-5 sm:py-3.5 sm:text-sm/6 md:max-w-md">
                    Book the cheapest direct flight to Sydney next Thursday morning and hold the
                    seat.
                  </div>
                </div>
              </StaggerChild>

              <StaggerChild range={[0.29, 0.35, 0.46, 0.51]} scrollYProgress={scrollYProgress}>
                <div className="flex gap-3">
                  <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-growth-green/15 shadow-[inset_0_0_12px_rgba(73,222,128,0.15)] sm:size-8">
                    <LightningIcon className="size-3 text-growth-green sm:size-3.5" />
                  </div>
                  <div className="min-w-0 rounded-2xl border border-growth-green/10 bg-growth-green/[0.04] px-4 py-3 text-[0.8125rem]/5 text-white/80 sm:px-5 sm:py-3.5 sm:text-sm/6 md:max-w-md">
                    Opening Chrome on your computer&hellip;
                  </div>
                </div>
              </StaggerChild>

              <StaggerChild range={[0.31, 0.37, 0.46, 0.51]} scrollYProgress={scrollYProgress}>
                <div className="max-w-72 space-y-2 rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3.5 sm:w-80 sm:max-w-none sm:space-y-2.5 sm:px-5 sm:py-4 md:w-96">
                  <div className="flex items-center gap-1.5 font-medium text-[0.625rem] text-white/60 sm:text-xs">
                    <ShareScreenIcon className="size-3 sm:size-3.5" />
                    Live screen
                  </div>
                  {[
                    "Typed: flights MEL to SYD",
                    "Clicked: Thursday, 7:00 AM",
                    "Read: 4 direct fares",
                  ].map((action) => (
                    <div
                      className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-white/60 text-xs sm:px-4 sm:py-2.5 sm:text-sm"
                      key={action}
                    >
                      {action}
                    </div>
                  ))}
                </div>
              </StaggerChild>
            </div>
          </StepGroup>

          {/* Step 3: the handover at the password field */}
          <StepGroup
            description={howItWorks[2].body}
            range={[0.5, 0.55, 0.7, 0.75]}
            scrollYProgress={scrollYProgress}
            step={howItWorks[2].step}
            title={howItWorks[2].title}
          >
            <div className="space-y-3">
              <StaggerChild range={[0.5, 0.55, 0.7, 0.75]} scrollYProgress={scrollYProgress}>
                <div className="flex items-center gap-2">
                  <Hand5FingerIcon className="size-4 shrink-0 text-growth-green" />
                  <span className="font-medium text-sm text-white/80">The seat is yours</span>
                </div>
              </StaggerChild>

              <StaggerChild range={[0.5, 0.56, 0.7, 0.74]} scrollYProgress={scrollYProgress}>
                <div className="max-w-[520px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0c0c0c]">
                  <div className="flex items-center gap-2 border-white/[0.06] border-b px-3 py-2 sm:px-4">
                    <span className="size-2 rounded-full bg-white/15" />
                    <span className="size-2 rounded-full bg-white/15" />
                    <span className="size-2 rounded-full bg-white/15" />
                    <span className="ml-2 truncate rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[0.625rem] text-white/40 sm:text-xs">
                      airline.example.com/checkout
                    </span>
                  </div>
                  <div className="space-y-3 p-4 sm:p-5">
                    <div className="text-white/60 text-xs sm:text-sm">Confirm your payment</div>
                    <div className="rounded-xl border border-white/[0.08] bg-[#1a1a1a] px-3 py-2.5 font-mono text-sm text-white/70 tracking-[0.3em] sm:px-4">
                      &bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border border-growth-green/15 bg-growth-green/[0.05] px-3 py-2.5 text-[0.6875rem] text-white/70 sm:px-4 sm:text-xs">
                      <LockIcon className="size-3.5 shrink-0 text-growth-green" />
                      The agent stopped here. It never sees what you type.
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-white/[0.06] border-t px-3 py-2.5 sm:px-4 sm:py-3">
                    <div className="flex items-center gap-1.5 sm:gap-2">
                      <span className="size-1.5 animate-pulse rounded-full bg-growth-green/70 motion-reduce:animate-none sm:size-2" />
                      <span className="font-mono text-[0.625rem] text-white/60 tabular-nums sm:text-xs">
                        You have the mouse
                      </span>
                    </div>
                    <div className="rounded-full bg-white px-3 py-1.5 font-medium text-[0.625rem] text-[#0a0a0a] sm:px-4 sm:text-xs">
                      I&rsquo;m done
                    </div>
                  </div>
                </div>
              </StaggerChild>
            </div>
          </StepGroup>

          {/* Step 4: it carries on without you, and you can reach it anywhere */}
          <StepGroup
            description={howItWorks[3].body}
            persist
            range={[0.74, 0.79, 0.95, 1]}
            scrollYProgress={scrollYProgress}
            step={howItWorks[3].step}
            title={howItWorks[3].title}
          >
            <div className="space-y-3">
              <StaggerChild persist range={[0.74, 0.79, 0.95, 1]} scrollYProgress={scrollYProgress}>
                <span className="flex items-center gap-2 font-medium text-white/80 text-xs sm:text-sm">
                  <CircleCheckIcon className="size-3.5 text-growth-green sm:size-4" />
                  Seat booked, laptop closed
                </span>
              </StaggerChild>

              <StaggerChild persist range={[0.75, 0.8, 0.95, 1]} scrollYProgress={scrollYProgress}>
                <div className="flex max-w-[420px] items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:gap-4 sm:px-5 sm:py-4">
                  <WhatsappIcon className="size-6 shrink-0 text-white/50 sm:size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white/80 text-xs sm:text-sm">WhatsApp</div>
                    <div className="text-[0.625rem] text-white/60 sm:text-xs">
                      Held 7:05 AM direct. Want me to pay?
                    </div>
                  </div>
                </div>
              </StaggerChild>

              <StaggerChild persist range={[0.76, 0.81, 0.95, 1]} scrollYProgress={scrollYProgress}>
                <div className="flex max-w-[420px] items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:gap-4 sm:px-5 sm:py-4">
                  <GlobeIcon className="size-6 shrink-0 text-white/50 sm:size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white/80 text-xs sm:text-sm">
                      Share the screen
                    </div>
                    <div className="text-[0.625rem] text-white/60 sm:text-xs">
                      One link, view only, expires in 30 minutes
                    </div>
                  </div>
                </div>
              </StaggerChild>

              <StaggerChild persist range={[0.77, 0.82, 0.95, 1]} scrollYProgress={scrollYProgress}>
                <div className="max-w-[420px] rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:px-5 sm:py-4">
                  <div className="flex items-center gap-2 font-medium text-white/80 text-xs sm:text-sm">
                    <ConsoleIcon className="size-3.5 text-white/50 sm:size-4" />
                    Your own CLI
                  </div>
                  <div className="mt-1.5 overflow-x-auto font-mono text-[0.625rem]/4 text-white/40 sm:mt-2 sm:text-xs/5">
                    <span className="text-growth-green/60">$ </span>
                    {siteConfig.installCommand}
                  </div>
                </div>
              </StaggerChild>
            </div>
          </StepGroup>
        </div>
      </div>
    </section>
  );
};
