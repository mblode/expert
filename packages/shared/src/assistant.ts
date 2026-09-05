export interface RuntimeSkill {
  id: string;
  description: string;
  markdown: string;
}
export interface RuntimeConfiguration {
  revision: number;
  instructions: string;
  memory_set: boolean;
  memory: string[];
  skills: RuntimeSkill[];
}
