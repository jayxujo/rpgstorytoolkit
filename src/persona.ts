// Persona = what the user builds. It maps to one of two default workspace experiences:
//   developer   → Conditions + Assets trees shown in the sidebar by default
//   storyteller → both hidden (Assets reveals after the first asset upload)
// Stored in localStorage so a guest's answer carries into account sign-up.

export type PersonaId = "video-games" | "tabletop" | "books" | "screen" | "comics" | "fun";
export type Experience = "developer" | "storyteller";

export const PERSONAS: { id: PersonaId; emoji: string; experience: Experience }[] = [
  { id: "video-games", emoji: "🎮", experience: "developer" },
  { id: "tabletop", emoji: "🎲", experience: "storyteller" },
  { id: "books", emoji: "📚", experience: "storyteller" },
  { id: "screen", emoji: "🎬", experience: "storyteller" },
  { id: "comics", emoji: "🦸", experience: "storyteller" },
  { id: "fun", emoji: "✨", experience: "storyteller" },
];

const KEY = "evenstory_persona";

export function getPersona(): PersonaId | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(KEY);
  return v && PERSONAS.some((p) => p.id === v) ? (v as PersonaId) : null;
}

export function setPersona(id: PersonaId) {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
}

export function experienceFor(id: PersonaId | null): Experience {
  if (!id) return "developer"; // preserve existing default when unknown
  return PERSONAS.find((p) => p.id === id)?.experience ?? "storyteller";
}

export function getExperience(): Experience {
  return experienceFor(getPersona());
}
