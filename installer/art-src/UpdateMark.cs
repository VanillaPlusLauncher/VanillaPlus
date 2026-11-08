using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

// The X in the update window (make-update-art.ps1 draws one picture of it per moment of the loop): it is
// built of pieces of its own picture that settle into place row by row from the bottom, a light glides
// over it and a spark lights up at its corner, then it breaks into pieces that float off away from its
// middle and fade, and the next loop builds it again. Pieces glide and stop without bouncing.
// Places are 1x pixels times the scale k; the X is 64 x 64 with its middle at (56, 64).
public static class UpdateMark {
  const int Grid = 8;                    // the X is cut into Grid x Grid pieces
  const double Fall = 14;                // how far above its place a piece starts, 1x pixels
  const double FallTime = 0.14;          // share of the loop a piece takes to settle
  const double BreakAt = 0.84;           // when the X starts to break up
  const double BreakTime = 0.07;

  static double Clamp(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  static double EaseOut(double t) { t = Clamp(t); return 1 - Math.Pow(1 - t, 3); }
  static double EaseIn(double t) { t = Clamp(t); return t * t * t; }
  static double EaseInOut(double t) { t = Clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2; }
  static int Px(double v, double k) { return (int)Math.Floor(v * k + 0.5); }
  static Color C(int r, int g, int b, double a) { return Color.FromArgb((int)Math.Max(0, Math.Min(255, a)), r, g, b); }

  static Bitmap Face(Bitmap mark, int s) {
    Bitmap face = new Bitmap(s, s, PixelFormat.Format32bppArgb);
    using (Graphics fg = Graphics.FromImage(face)) {
      fg.InterpolationMode = InterpolationMode.HighQualityBicubic;
      fg.PixelOffsetMode = PixelOffsetMode.HighQuality;
      fg.DrawImage(mark, new Rectangle(0, 0, s, s));
    }
    return face;
  }

  // Lightens the X along a "/" band whose middle is at d (-1 top left .. 1 bottom right).
  static void Shine(Bitmap face, double d, double width, double strength) {
    int s = face.Width;
    BitmapData data = face.LockBits(new Rectangle(0, 0, s, s), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int[] px = new int[s * s];
    System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);
    for (int y = 0; y < s; y++) for (int x = 0; x < s; x++) {
      int i = y * s + x; int a = (px[i] >> 24) & 255; if (a == 0) continue;
      double q = (((double)x + y) / s - 1 - d) / width;
      double t = Math.Exp(-q * q) * strength;
      if (t < 0.01) continue;
      int r = (px[i] >> 16) & 255, g = (px[i] >> 8) & 255, b = px[i] & 255;
      r = (int)(r + (255 - r) * t); g = (int)(g + (255 - g) * t); b = (int)(b + (255 - b) * t);
      px[i] = (a << 24) | (r << 16) | (g << 8) | b;
    }
    System.Runtime.InteropServices.Marshal.Copy(px, 0, data.Scan0, px.Length);
    face.UnlockBits(data);
  }

  // A light passing over the X (t from 0 to 1): a bright band and a thin one after it.
  static void Gleam(Bitmap face, double t) {
    if (t <= 0 || t >= 1) return;
    double d = -1.35 + 2.7 * EaseInOut(t);
    Shine(face, d, 0.085, 0.85);
    Shine(face, d - 0.2, 0.045, 0.55);
  }

  // 0..1..0 around `at` (a share of the loop), `span` long.
  static double Life(double p, double at, double span) {
    double x = (p - at) / span;
    if (Math.Abs(x) >= 0.5) return 0;
    double c = Math.Cos(Math.PI * x); return c * c;
  }

  // A spark: a pixel cross with a soft halo that grows and fades (life 0..1), its middle at (x, y).
  static void Sparkle(Graphics g, double k, double x, double y, double life) {
    if (life <= 0.02) return;
    int u = Math.Max(1, (int)Math.Round(k));
    int cx = Px(x, k), cy = Px(y, k);
    using (GraphicsPath halo = new GraphicsPath()) {
      float r = (float)(6 * k * life);
      halo.AddEllipse(cx - r, cy - r, 2 * r, 2 * r);
      using (PathGradientBrush hb = new PathGradientBrush(halo)) {
        hb.CenterColor = C(0xd9, 0xc8, 0xff, 110 * life);
        hb.SurroundColors = new Color[] { C(0xd9, 0xc8, 0xff, 0) };
        g.FillPath(hb, halo);
      }
    }
    SmoothingMode keep = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.None;
    int arm = (int)Math.Round(1 + 2.6 * life);
    double alpha = 255 * Math.Min(1, life * 1.6);
    using (SolidBrush tip = new SolidBrush(C(0xb9, 0x96, 0xff, alpha)))
    using (SolidBrush mid = new SolidBrush(C(0xef, 0xe6, 0xff, alpha)))
    using (SolidBrush core = new SolidBrush(C(0xff, 0xff, 0xff, alpha))) {
      for (int i = 1; i <= arm; i++) {
        SolidBrush b = i == arm ? tip : mid;
        g.FillRectangle(b, cx + i * u, cy, u, u); g.FillRectangle(b, cx - i * u, cy, u, u);
        g.FillRectangle(b, cx, cy + i * u, u, u); g.FillRectangle(b, cx, cy - i * u, u, u);
      }
      g.FillRectangle(core, cx, cy, u, u);
    }
    g.SmoothingMode = keep;
  }

  struct Piece { public int Col, Row; public double In, Out; }

  // The pieces that have something of the X, each with when it comes in and when it goes.
  static List<Piece> Pieces(Bitmap face) {
    List<Piece> pieces = new List<Piece>();
    Random random = new Random(7);
    int size = face.Width / Grid;
    for (int row = 0; row < Grid; row++) for (int col = 0; col < Grid; col++) {
      bool any = false;
      for (int y = 0; y < size && !any; y++) for (int x = 0; x < size && !any; x++) any = face.GetPixel(col * size + x, row * size + y).A > 40;
      if (!any) continue;
      Piece piece = new Piece();
      piece.Col = col; piece.Row = row;
      piece.In = 0.26 * (Grid - 1 - row) / (Grid - 1) + 0.07 * random.NextDouble();
      piece.Out = 0.09 * random.NextDouble();
      pieces.Add(piece);
    }
    return pieces;
  }

  // Draws the X at moment p (0..1 of the loop); p < 0: the whole X standing still.
  public static void Paint(Graphics g, Bitmap mark, double k, double p) {
    int s = Px(64, k), size = s / Grid;
    int left = Px(24, k), top = Px(32, k);
    using (Bitmap face = Face(mark, s)) {
      if (p < 0) {
        g.DrawImage(face, left, top, s, s);
        return;
      }
      List<Piece> pieces = Pieces(face);
      Gleam(face, (p - 0.5) / 0.22);
      PixelOffsetMode keepOffset = g.PixelOffsetMode;
      InterpolationMode keepMode = g.InterpolationMode;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      g.InterpolationMode = InterpolationMode.NearestNeighbor;
      foreach (Piece piece in pieces) {
        double x = left + piece.Col * size, y = top + piece.Row * size, alpha = 1;
        double t = (p - piece.In) / FallTime;
        if (t <= 0) continue;
        if (t < 1) {
          y -= (1 - EaseOut(t)) * Fall * k;
          alpha = Clamp(t * 3);
        }
        double o = (p - BreakAt - piece.Out) / BreakTime;
        if (o >= 1) continue;
        if (o > 0) {
          // Away from the X's middle, a little up, fading.
          double e = EaseIn(o);
          y -= e * 12 * k;
          x += e * (piece.Col - (Grid - 1) / 2.0) / ((Grid - 1) / 2.0) * 7 * k;
          alpha *= 1 - o;
        }
        ColorMatrix fade = new ColorMatrix();
        fade.Matrix33 = (float)alpha;
        using (ImageAttributes attributes = new ImageAttributes()) {
          attributes.SetColorMatrix(fade);
          g.DrawImage(face, new Rectangle((int)Math.Round(x), (int)Math.Round(y), size, size), piece.Col * size, piece.Row * size, size, size, GraphicsUnit.Pixel, attributes);
        }
      }
      g.PixelOffsetMode = keepOffset;
      g.InterpolationMode = keepMode;
    }
    Sparkle(g, k, 84, 37, Life(p, 0.7, 0.18));
  }
}
