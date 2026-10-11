export {
  createSongFlow,
  createSongStage,
};

/* Song change in the scrolling layout, as one strict sequence:

     show  ->  leaving  ->  empty  ->  entering  ->  show

   show      the lyrics of the current song.
   leaving   the song changed: what is on screen is LOCKED (frozen at the time it had) and dragged up off the screen.
             Nothing else is loaded or drawn meanwhile.
   empty     an empty screen while the next song's lyrics are looked for (a song that has none stays like this).
   entering  the new lyrics are loaded and dragged in from below.

   Pure (no DOM, no clock of its own, no song objects): tests/test_transition.js runs it frame by frame. */
// seconds. Leaving is quicker than entering; the lines further down trail a little (lag per line, at most maxLag).
const SONG_TR = { dur: 0.95, lag: 0.04, maxLag: 0.35, outDur: 0.6, outMaxLag: 0.2 };

function createSongStage(ease, cfg = SONG_TR){
  let phase = 'show', t0 = 0, scale = 1, from = null, lastT = 0, frozenT = 0;
  const endIn = cfg.dur + cfg.maxLag, endOut = cfg.outDur + cfg.outMaxLag;
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  const prog = (start, j, first, at, dur, maxLag) =>
    ease(clamp01(((at - start) / 1000 - Math.min(maxLag, Math.max(0, j - first) * cfg.lag)) / dur));
  const stage = {
    onEmpty: null,                                   // called (once) when the old lyrics have left
    get phase(){ return phase; },
    /* the song changed: lock what is shown and drag it away. hasLines false: nothing shown, go straight to empty. */
    leave(now, hasLines = true){
      if (phase === 'leaving' || phase === 'empty') return;
      if (!hasLines){ phase = 'empty'; return; }
      // switched away while it was still sliding in: carry on from where it is (no jump), a little slower
      const wasEntering = phase === 'entering', e0 = t0;
      scale = wasEntering ? 1 + (1 - prog(e0, 0, 0, now, cfg.dur, cfg.maxLag)) : 1;
      from = wasEntering ? (j, f, D) => D * (1 - prog(e0, j, f, now, cfg.dur, cfg.maxLag)) : null;
      frozenT = lastT; phase = 'leaving'; t0 = now;
    },
    /* the new lyrics are loaded: drag them in. Only from empty (or show, for lyrics loaded by hand). */
    enter(now){ phase = 'entering'; t0 = now; from = null; },
    reset(){ phase = 'show'; from = null; },
    /* once per frame with the song time t of the current song. Returns what to draw:
         draw: false (empty), 'out' (the locked old lyrics at frozenT, with shift), 'cur' (the current song, shift or null) */
    step(now, t){
      if (phase === 'show' || phase === 'entering') lastT = t;
      if (phase === 'leaving' && (now - t0) / 1000 > endOut * scale){
        phase = 'empty';
        if (stage.onEmpty) stage.onEmpty();
      }
      if (phase === 'entering' && (now - t0) / 1000 > endIn) phase = 'show';
      if (phase === 'empty') return { phase, draw: false, busy: true };
      if (phase === 'leaving'){
        const start = t0, S = scale, F = from;
        return { phase, draw: 'out', t: frozenT, busy: true,
                 shift: (j, f, D) => { const e = prog(start, j, f, now, cfg.outDur * S, cfg.outMaxLag * S);
                                        return (F ? F(j, f, D) * (1 - e) : 0) - D * e; } };
      }
      if (phase === 'entering'){
        const start = t0;
        return { phase, draw: 'cur', t, busy: true, shift: (j, f, D) => D * (1 - prog(start, j, f, now, cfg.dur, cfg.maxLag)) };
      }
      return { phase, draw: 'cur', t, busy: false, shift: null };
    },
  };
  return stage;
}

/* What happens when the player changes song, independent of drawing and of the network:
     trackChanged(s)         the player is on a new song s: lock and send the old lyrics away (or blank at once when
                             the layout has no such animation)
     lyrics(seq, s, res)     the lookup for song s finished (res.lrc null = none); a lookup for a song that is no
                             longer the latest is dropped
     tick()                  call when the stage became empty (and any time): applies a waiting result
   Nothing is loaded before the old lyrics have left; the newest song always wins. */
function createSongFlow(stage, hooks){
  let result = null, seq = 0;
  function advance(now){
    if (!result) return;
    if (hooks.scroll() && stage.phase !== 'empty') return;       // still leaving: keep the result for later
    const r = result; result = null;
    if (r.res && r.res.lrc && hooks.load(r.s, r.res)){
      if (hooks.scroll()) stage.enter(now);
    } else hooks.none(r.s, r.res);                               // stays empty
  }
  return {
    trackChanged(now, s){
      result = null; seq++;
      if (hooks.scroll()) stage.leave(now, hooks.hasLines());
      else hooks.blank(s);
      return seq;
    },
    lyrics(now, mySeq, s, res){
      if (mySeq !== seq) return false;
      result = { s, res };
      advance(now);
      return true;
    },
    tick(now){ advance(now); },
  };
}
