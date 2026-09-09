import { z } from "zod";

const number = z.number().finite();
const vector = z.tuple([number, number, number]);
const coordinate = z.number().min(0).max(1);
const point = z.tuple([coordinate, coordinate]);

export const feedbackView = z.object({
  camera: z.object({
    type: z.enum(["PerspectiveCamera", "OrthographicCamera"]),
    position: vector,
    quaternion: z.tuple([number, number, number, number]),
    up: vector,
    near: z.number().nonnegative(),
    far: z.number().positive(),
    zoom: z.number().positive(),
    fov: z.number().positive().max(179).optional(),
    left: number.optional(), right: number.optional(), top: number.optional(), bottom: number.optional(),
  }),
  target: vector,
  shading: z.enum(["solid", "realistic", "normals", "wireframe"]),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
});
export const feedbackInput = z.object({
  id: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  scene_revision: z.number().int().nonnegative(),
  targets: z.array(z.object({
    uuid: z.string().min(1).max(120), name: z.string().max(120), type: z.string().max(80),
    point: vector.optional(),
    rect: z.tuple([coordinate, coordinate, coordinate, coordinate]).optional(),
  })).max(20),
  strokes: z.array(z.object({
    kind: z.enum(["pen", "arrow", "box", "circle"]),
    points: z.array(point).min(1).max(512),
  })).max(50),
  view: feedbackView,
  image: z.string().max(1_500_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
});
export const feedbackQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  images: z.enum(["0", "1"]).default("0"),
});
export const resolveFeedbackInput = z.object({ feedback_ids: z.array(z.uuid()).min(1).max(100) });
export type FeedbackNote = Omit<z.infer<typeof feedbackInput>, "image"> & {
  sequence: number;
  created_at: string;
  image_url: string;
  image?: string;
};
export type FeedbackPage = { notes: FeedbackNote[]; pending_count: number; version: number; has_more: boolean; next_after: number };
export type FeedbackResolution = { resolved_ids: string[]; pending_count: number; version: number };
