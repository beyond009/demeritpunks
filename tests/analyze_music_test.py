"""Signal-level regressions for the offline drum-stem lighting pipeline."""
import base64
import importlib.util
import pathlib
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('music_analysis',pathlib.Path(__file__).resolve().parents[1]/'scripts/analyze_music.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)


def hit(samples,time,frequency,decay=30):
    start=int(time*a.RATE);count=min(int(.65*a.RATE),len(samples)-start)
    t=np.arange(count)/a.RATE
    samples[start:start+count]+=.3*np.sin(2*np.pi*frequency*t)*np.exp(-decay*t)


class PercussionTest(unittest.TestCase):
    def test_guitar_mix_with_silent_drum_stem_has_no_accents(self):
        t=np.arange(a.RATE*8)/a.RATE
        guitar=.2*np.tanh(4*np.sin(2*np.pi*220*t))
        cues,_=a.analyze(np.zeros_like(guitar),guitar)
        self.assertEqual(cues['accents'],[])
        self.assertTrue(all(p['kind']=='quiet' for p in cues['phrases']))

    def test_band_leakage_does_not_create_other_drums_or_crash(self):
        for kind,frequency,decay in [('kick',65,30),('snare',1800,30),('cymbal',7200,80)]:
            samples=np.zeros(a.RATE*3);hit(samples,1,frequency,decay)
            events=a.extract_drums(samples,samples)['events']
            self.assertTrue(events,kind)
            self.assertTrue(all(e['type']==kind for e in events),events)
            self.assertLess(abs(events[0]['time']-1),.025)
            if kind=='cymbal':self.assertFalse(events[0]['crash'])

    def test_guitar_intro_then_drums_and_continuous_channels(self):
        t=np.arange(a.RATE*14)/a.RATE
        stem=np.zeros_like(t)
        for index,time in enumerate(np.arange(6,13.8,.5)):
            hit(stem,time,65 if index%2==0 else 1800)
        mix=stem+.025*np.tanh(3*np.sin(2*np.pi*330*t))
        cues,_=a.analyze(stem,mix)
        self.assertFalse(any(e['time']<5.95 for e in cues['accents']))
        self.assertGreater(len(cues['accents']),8)
        self.assertEqual(cues['phrases'][0]['kind'],'quiet')
        self.assertTrue(5.8<cues['phrases'][0]['end']<6.1)
        for event in cues['accents']:
            self.assertLess(min(abs(event['time']-time) for time in np.arange(6,13.8,.5)),.025)
        n=int(np.ceil(cues['duration']*a.FPS))+1
        for name,data in cues['channels'].items():
            values=np.frombuffer(base64.b64decode(data),dtype=np.uint8)
            self.assertEqual(len(values),n)
            if name.startswith('angle'):
                # One byte is .137 degrees: no abrupt phase resets at phrases.
                self.assertLessEqual(np.max(np.abs(np.diff(values.astype(int)))),1)
            elif name in ['left','right']:
                self.assertGreaterEqual(values.min(),round(.34*255))

    def test_cadence_is_stable_when_every_third_hit_is_louder(self):
        beats=np.arange(0,12,1/3).tolist()
        events=[{'time':time,'type':'kick','strength':1 if i%3==0 else .65} for i,time in enumerate(beats)]
        phrases=[{'start':0,'end':12,'kind':'groove','style':0}]
        selected=a.arrange_accents(events,phrases,beats)
        times=np.array([e['time'] for e in selected])
        self.assertGreater(len(times),14)
        np.testing.assert_allclose(np.diff(times),2/3,atol=.001)

    def test_active_span_keeps_track_edges_and_weak_continuation(self):
        activity=np.ones(1003);activity[300:700]=.13
        events=[{'time':time,'type':'kick'} for time in np.arange(0,10,.5)]
        spans=a.active_spans(activity,events,10)
        self.assertEqual(spans,[[0,10]])


if __name__=='__main__':unittest.main()
