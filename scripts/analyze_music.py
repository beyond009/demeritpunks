"""Build a deterministic 50 Hz light score from a separated drum stem.

Run separate_drums.py first. NumPy/SciPy/librosa perform band onset and beat
tracking offline. Only packed light channels go to the browser, never models
or stems. The percussion instrument labels are band/attack estimates.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import numpy as np
from scipy import ndimage, signal
import librosa

ROOT = pathlib.Path(__file__).resolve().parents[1]
RATE, HOP, WINDOW, FPS = 22050, 220, 2048, 50
TRACKS = ['childhood-nightmare', 'walking-out-of-fog', 'barefaced-lies', 'bye-bye-my-country']


def decode(path, rate=RATE):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le',
                                   '-ac', '1', '-ar', str(rate), '-'])
    return np.frombuffer(raw, dtype='<f4')


def normalize(values, percentile=95):
    return np.clip(values / max(float(np.percentile(values, percentile)), 1e-8), 0, 1)


def smooth(values, seconds, fps=RATE / HOP):
    return ndimage.gaussian_filter1d(values, max(.1, seconds * fps), mode='nearest')


def frames(samples):
    return np.lib.stride_tricks.sliding_window_view(np.pad(samples, (WINDOW//2, WINDOW//2)), WINDOW)[::HOP]


def extract_drums(stem, mix):
    """Band-separated attack estimates; no claim of exact drum transcription."""
    matrix = frames(stem)
    spectrum = np.abs(np.fft.rfft(matrix * np.hanning(WINDOW), axis=1)).astype(np.float32)
    freq = np.fft.rfftfreq(WINDOW, 1 / RATE)
    rms = np.sqrt(np.mean(matrix ** 2, axis=1))
    mix_rms = np.sqrt(np.mean(frames(mix[:len(stem)]) ** 2, axis=1))
    if len(mix_rms) != len(rms):
        mix_rms = np.interp(np.arange(len(rms)), np.linspace(0, len(rms)-1, len(mix_rms)), mix_rms)
    bands = {}
    total_power = np.sum(spectrum ** 2, axis=1) + 1e-12
    for name, low, high in [('kick', 35, 170), ('body', 170, 650), ('snare', 650, 4400), ('cymbal', 5000, 10500)]:
        values = spectrum[:, (freq >= low) & (freq < high)]
        magnitude = np.sqrt(np.mean(values**2, axis=1))
        # Difference in linear amplitude preserves absolute quiet-vs-loud scale.
        novelty = np.mean(np.maximum(0, np.diff(values, axis=0, prepend=values[:1])), axis=1)
        share = np.sum(values ** 2, axis=1) / total_power
        minimum_share = {'kick':.045, 'body':.035, 'snare':.08, 'cymbal':.06}[name]
        novelty[share < minimum_share] = 0
        bands[name] = {'energy': magnitude, 'flux': np.clip(novelty / max(float(np.percentile(novelty,98)), float(np.max(novelty))*.15, 1e-8),0,1), 'share':share}
    snare_flux = .42 * bands['body']['flux'] + .58 * bands['snare']['flux']
    kick_flux, cymbal_flux = bands['kick']['flux'], bands['cymbal']['flux']
    stem_floor = max(.0015, float(np.percentile(rms, 85)) * .045)
    mix_floor = max(.003, float(np.percentile(mix_rms, 85)) * .025)
    present = (rms > stem_floor) & (mix_rms > mix_floor)
    events = []
    for kind, novelty, distance, prominence in [
        ('kick', kick_flux, .105, .07), ('snare', snare_flux, .11, .08), ('cymbal', cymbal_flux, .18, .12)]:
        local = smooth(novelty, .3)
        candidates, _ = signal.find_peaks(novelty, distance=int(distance*RATE/HOP), prominence=prominence)
        for i in candidates:
            if not present[i] or novelty[i] < max(.115, local[i]*1.12):
                continue
            share=bands[kind]['share'][i]
            if (kind=='kick' and share<.25) or (kind=='snare' and share<.22) or (kind=='cymbal' and share<.18):
                continue
            if bands[kind]['energy'][i] < np.max(bands[kind]['energy'])*.04:
                continue
            # Snare needs an actual mid-band body, rather than isolated hat fizz.
            if kind == 'snare' and bands['body']['flux'][i] < .055 and bands['snare']['flux'][i] < .24:
                continue
            # Frames are centred. Flux peaks already locate the attack; backtracking
            # by a whole FFT window would make the light lead audible percussion.
            time = max(0, i*HOP/RATE)
            strength = float(np.clip(novelty[i], 0, 1))
            event = {'time': round(time, 4), 'type': kind, 'strength': round(strength, 4)}
            if kind == 'cymbal':
                high = bands['cymbal']['energy']
                peak = np.max(high[max(0,i-2):min(len(high),i+5)])
                tail = np.mean(high[min(len(high)-1,i+int(.12*RATE/HOP)):min(len(high),i+int(.35*RATE/HOP))])
                prior = np.mean(high[max(0,i-int(.12*RATE/HOP)):max(1,i)])
                event['sustain'] = float(tail / max(peak, 1e-6))
                event['crash'] = bool(strength > .35 and peak > prior*1.35 and event['sustain'] > .16)
            events.append(event)
    events.sort(key=lambda e:e['time'])
    onset = normalize(.48*kick_flux + .52*snare_flux, 97)
    onset[~present] = 0
    # Track-level energy gate avoids boosting residual guitar in the drum stem.
    activity = np.minimum(normalize(smooth(rms,.3),80), normalize(smooth(onset,.45),70))
    activity[mix_rms < mix_floor] = 0
    return {'events':events, 'onset':onset, 'rms':rms, 'mix_rms':mix_rms, 'activity':activity,
            'stem_floor':stem_floor, 'bands':bands}


def track_beats(onset):
    """Dynamic-programming beat tracker with slowly varying tempo prior."""
    if not np.any(onset > .05):
        return [], [], 120.0
    global_tempo = float(np.ravel(librosa.feature.tempo(onset_envelope=onset, sr=RATE,
        hop_length=HOP, start_bpm=150, std_bpm=.65, max_tempo=230))[0])
    tempo = librosa.feature.tempo(onset_envelope=onset, sr=RATE, hop_length=HOP,
        start_bpm=global_tempo, std_bpm=.3, max_tempo=230, ac_size=8, aggregate=None)
    tempo = ndimage.median_filter(tempo, size=int(3*RATE/HOP)//2*2+1)
    tempo = np.clip(tempo, max(65,global_tempo*.78), min(230,global_tempo*1.28))
    _, indices = librosa.beat.beat_track(onset_envelope=onset, sr=RATE,
        hop_length=HOP, bpm=tempo, tightness=90, trim=False)
    beats = np.asarray(indices) * HOP / RATE
    tempo_points = [{'time':round(i*HOP/RATE,3),'bpm':round(float(tempo[i]),2)}
                    for i in range(0,len(tempo),int(2*RATE/HOP))]
    return np.round(beats,4).tolist(), tempo_points, global_tempo


def active_spans(activity, events, duration):
    fps = RATE/HOP
    active = activity > .09
    # Close short inter-hit gaps while preserving actual long breakdowns.
    pad = int(fps)
    active = np.pad(active, pad, mode='edge')
    active = ndimage.binary_closing(active, structure=np.ones(int(.75*fps)))
    active = ndimage.binary_opening(active, structure=np.ones(int(.22*fps)))
    active = active[pad:-pad]
    transitions = np.diff(np.r_[False,active,False].astype(int))
    starts, ends = np.where(transitions==1)[0],np.where(transitions==-1)[0]
    spans=[]
    hits = [e['time'] for e in events if e['type']!='cymbal']
    for start,end in zip(starts,ends):
        a,b=start/fps,min(duration,end/fps)
        near=[t for t in hits if a-.3<=t<b+.15]
        if b-a>.5 and len(near)>=2 and np.max(activity[start:end])>.23:
            spans.append([max(0,a,near[0]-.025),min(duration,max(b,near[-1]+.15))])
    return spans


def make_phrases(features, beats, duration, global_tempo):
    spans=active_spans(features['activity'],features['events'],duration)
    phrases=[]; cursor=0
    overall_energy=float(np.percentile(features['mix_rms'],80))
    for a,b in spans:
        if a>cursor:phrases.append({'start':cursor,'end':a,'kind':'quiet'})
        local_beats=[t for t in beats if a<=t<b]
        # Four-bar groups. Boundaries are musical beat positions, not seconds.
        boundaries=[a]+local_beats[16::16]+[b]
        if len(boundaries)>2 and boundaries[-1]-boundaries[-2]<1.8:boundaries.pop(-2)
        for lo,hi in zip(boundaries,boundaries[1:]):
            samples=features['mix_rms'][int(lo*RATE/HOP):int(hi*RATE/HOP)]
            hits=[e for e in features['events'] if e['type']!='cymbal' and lo<=e['time']<hi]
            energy=float(np.mean(samples)/max(overall_energy,1e-6)) if len(samples) else 0
            rate=len(hits)/max(hi-lo,.1)
            kind='dense' if energy>.94 and rate>3.8 else 'groove'
            phrases.append({'start':lo,'end':hi,'kind':kind,'energy':min(1,energy),'density':round(rate,2)})
        cursor=b
    if cursor<duration:phrases.append({'start':cursor,'end':duration,'kind':'quiet'})
    if not phrases:phrases=[{'start':0,'end':duration,'kind':'quiet'}]
    # Actual fast drum flurries near a phrase ending identify small fill passages.
    output=[]
    for phrase in phrases:
        lo,hi=phrase['start'],phrase['end']
        start=max(lo,hi-min(1.25,240/global_tempo))
        fill_hits=[e for e in features['events'] if e['type']=='snare' and start<=e['time']<hi]
        preceding=[e for e in features['events'] if e['type']=='snare' and lo<=e['time']<start]
        baseline=len(preceding)/max(start-lo,.1)
        local_rate=len(fill_hits)/max(hi-start,.1)
        if phrase['kind']!='quiet' and hi-lo>3 and len(fill_hits)>=4 and local_rate>max(2.8,baseline*1.7):
            output.append({**phrase,'end':start})
            output.append({**phrase,'start':start,'kind':'fill'})
        else:output.append(phrase)
    for i,phrase in enumerate(output):
        phrase['start']=round(phrase['start'],4);phrase['end']=round(phrase['end'],4)
        phrase['style']=i%4
    return output


def phrase_at(phrases,time):
    return next((p for p in phrases if p['start']<=time<p['end']),phrases[-1])


def arrange_accents(events, phrases, beats):
    candidates=[]
    for event in events:
        if event['type']=='cymbal':continue
        p=phrase_at(phrases,event['time'])
        if p['kind']=='quiet':continue
        strength=event['strength']
        if strength<.19:continue
        grid_distance=min((abs(t-event['time']) for t in beats),default=.2)
        weight=strength*(1.22 if event['type']=='kick' else 1.1)
        weight*=1+.25*np.exp(-grid_distance**2/(2*.065**2))
        candidates.append({**event,'weight':float(weight),'phrase':p})
    # Merge truly simultaneous kick/snare attacks; do not double-flash a hit.
    groups=[]
    for e in candidates:
        if groups and e['time']-groups[-1][-1]['time']<.065:groups[-1].append(e)
        else:groups.append([e])
    merged=[max(group,key=lambda e:e['weight']) for group in groups]
    # Choose a continuous cadence from the tracked grid first, then find an
    # actual attack near each slot. Loud off-beat guitar/bleed cannot pull the
    # whole sequence away from the beat. Fast songs use a half-time light pulse.
    intervals=np.diff(beats)
    beat_period=float(np.median(intervals)) if len(intervals) else .5
    stride=2 if beat_period<.45 else 1
    chosen=[]
    for index,t in enumerate(beats):
        p=phrase_at(phrases,t)
        if p['kind']=='quiet':continue
        # Fill passages may add one genuine intervening drum accent.
        if index%stride and p['kind']!='fill':continue
        radius=min(.15,beat_period*.34)
        nearby=[e for e in merged if abs(e['time']-t)<=radius]
        if not nearby:continue
        e=max(nearby,key=lambda e:e['weight']*(1-.3*abs(e['time']-t)/radius))
        if all(abs(e['time']-a['time'])>=max(.30,beat_period*.78) for a in chosen):chosen.append(e)
    # A loud entrance is allowed to anchor a new active passage even if its
    # first real attack falls between two tracker slots.
    for p in phrases:
        if p['kind']=='quiet':continue
        previous=phrase_at(phrases,max(0,p['start']-.05))
        if previous['kind']!='quiet' or previous['end']-previous['start']<=2:continue
        entry=[e for e in merged if p['start']<=e['time']<p['start']+.5]
        if entry:
            e=entry[0]
            chosen=[a for a in chosen if abs(e['time']-a['time'])>=max(.30,beat_period*.78)]
            chosen.append(e)
    accents=[]
    for e in sorted(chosen,key=lambda e:e['time']):
        p=e['phrase'];kind=e['type']
        if p['kind']=='fill':kind='fill'
        if p['kind']!='quiet' and e['time']-p['start']<.6:
            previous=phrase_at(phrases,max(0,p['start']-.05))
            if previous['kind']=='quiet' and previous['end']-previous['start']>2:kind='impact'
        side=-1
        if kind=='snare' and p['style']%4 in [1,2]:side=p['style']%4-1
        if kind=='fill':side=len(accents)%2
        accents.append({'time':round(e['time'],4),'type':kind,'strength':round(e['strength'],4),'side':side})
    return accents


def add_envelope(channel, time, strength, attack, hold, release):
    start=max(0,int(np.floor(time*FPS)));end=min(len(channel),int(np.ceil((time+attack+hold+release*5)*FPS)))
    ages=np.arange(start,end)/FPS-time
    rise=np.clip(ages/attack,0,1);rise=rise*rise*(3-2*rise)
    fall=np.exp(-np.maximum(0,ages-attack-hold)/release)
    values=np.where(ages>=0,rise*fall*strength,0)
    channel[start:end]=np.maximum(channel[start:end],values)


def encode(values):
    return base64.b64encode(np.round(np.clip(values,0,1)*255).astype(np.uint8).tobytes()).decode('ascii')


def bake_score(features,phrases,accents,events,beats,tempo,duration):
    times=np.arange(int(np.ceil(duration*FPS))+1)/FPS;n=len(times)
    mix=normalize(np.interp(times,np.arange(len(features['mix_rms']))*HOP/RATE,features['mix_rms'])**.65)
    base=np.full(n,.38);period=np.full(n,18.);amplitude=np.full(n,15.);bias=np.zeros(n)
    for p in phrases:
        keep=(times>=p['start'])&(times<p['end']);kind=p['kind'];style=p['style']
        if kind=='quiet':base[keep]=.49;period[keep]=27;amplitude[keep]=12
        elif kind=='groove':base[keep]=.35;period[keep]=np.clip(32*60/tempo,16,23);amplitude[keep]=14.5+style*.6
        elif kind=='dense':base[keep]=.37;period[keep]=np.clip(32*60/tempo,13,18);amplitude[keep]=16.5
        else:base[keep]=.36;period[keep]=15;amplitude[keep]=15.5
        bias[keep]=[0,.8,-.8,0][style]
    base=ndimage.gaussian_filter1d(base,.5*FPS)
    speed=ndimage.gaussian_filter1d(2*np.pi/period,.8*FPS)
    amplitude=ndimage.gaussian_filter1d(amplitude,.8*FPS)
    bias=ndimage.gaussian_filter1d(bias,.8*FPS)
    phase=1+np.cumsum(speed)/FPS
    breath=.025*np.sin(times*2*np.pi/8)+.015*mix
    left=base+breath;right=base+breath
    pulse_l=np.zeros(n);pulse_r=np.zeros(n)
    for a in accents:
        kind=a['type'];strength=a['strength'];side=a['side']
        attack,hold,release={'kick':(.035,.065,.13),'snare':(.025,.03,.075),
                            'fill':(.025,.04,.09),'impact':(.04,.09,.18)}[kind]
        phrase=phrase_at(phrases,a['time'])
        variation=[.92,1.,1.08,.97][phrase['style']]
        hold*=variation;release*=variation
        peak=(.43+.17*strength)*([.97,1.,1.03,1.][phrase['style']])
        l,r=1.,1.
        if side==0:r=.86
        if side==1:l=.86
        add_envelope(pulse_l,a['time'],peak*l,attack,hold,release)
        add_envelope(pulse_r,a['time'],peak*r,attack,hold,release)
    left=np.clip(left+pulse_l,.34,.98);right=np.clip(right+pulse_r,.34,.98)
    wash=np.zeros(n)
    for event in events:
        if event['type']=='cymbal' and event.get('crash'):
            add_envelope(wash,event['time'],.07+.07*event['strength'],.08,.08,.45)
    haze=np.clip(.40+.12*smooth(mix,.25,FPS)+wash+.12*smooth(np.maximum(pulse_l,pulse_r),.16,FPS),.34,.86)
    center=132.5
    angle_l=center+amplitude*np.sin(phase)+bias*.3
    angle_r=center+amplitude*np.sin(phase+.035)+bias*.3
    channels={'left':encode(left),'right':encode(right),'haze':encode(haze),
              'angleLeft':encode((np.clip(angle_l,115,150)-115)/35),
              'angleRight':encode((np.clip(angle_r,115,150)-115)/35)}
    return channels


def analyze(stem,mix,duration=None):
    duration=duration or len(mix)/RATE
    # Separator output must share the decoded source's sample origin and length.
    stem=np.pad(stem,(0,max(0,len(mix)-len(stem))))[:len(mix)]
    features=extract_drums(stem,mix)
    beats,tempo_points,tempo=track_beats(features['onset'])
    phrases=make_phrases(features,beats,duration,tempo)
    accents=arrange_accents(features['events'],phrases,beats)
    channels=bake_score(features,phrases,accents,features['events'],beats,tempo,duration)
    counts={kind:sum(e['type']==kind for e in features['events']) for kind in ['kick','snare','cymbal']}
    cues={'version':3,'duration':round(duration,4),'fps':FPS,'encoding':'u8-base64','channels':channels,
          'beats':beats,'tempo':tempo_points,'phrases':phrases,'accents':accents,
          'analysis':{'separator':'htdemucs','method':'drum-stem/band-attacks/dynamic-beat-tracking/phrase-score','phraseLabels':'estimated',
                      'instrumentLabels':'estimated','tempo':round(tempo,2),'events':counts,
                      'crashes':sum(e.get('crash',False) for e in features['events']),
                      'stemOffsetSamples':0,'stemSampleRate':RATE}}
    return cues,features


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--stems',type=pathlib.Path,required=True)
    parser.add_argument('--track',choices=TRACKS,action='append')
    parser.add_argument('--diagnostics',type=pathlib.Path)
    args=parser.parse_args()
    for slug in args.track or TRACKS:
        mp3=ROOT/'audio'/f'{slug}.mp3';stem_path=args.stems/f'{slug}.wav'
        mix,stem=decode(mp3),decode(stem_path)
        cues,features=analyze(stem,mix)
        cues['analysis']['sourceSha256']=hashlib.sha256(mp3.read_bytes()).hexdigest()
        (ROOT/'audio'/f'{slug}.json').write_text(json.dumps(cues,separators=(',',':'))+'\n')
        if args.diagnostics:
            args.diagnostics.mkdir(parents=True,exist_ok=True)
            diagnostic={'phrases':cues['phrases'],'analysis':cues['analysis'],'events':features['events'],
                        'blocks':[{'time':round(i*HOP/RATE,2),'mixRms':float(features['mix_rms'][i:i+int(2*RATE/HOP)].mean()),
                        'stemRms':float(features['rms'][i:i+int(2*RATE/HOP)].mean()),
                        'activity':float(features['activity'][i:i+int(2*RATE/HOP)].mean())}
                        for i in range(0,len(features['rms']),int(2*RATE/HOP))]}
            (args.diagnostics/f'{slug}.json').write_text(json.dumps(diagnostic,separators=(',',':')))
        print(json.dumps({'track':slug,'analysis':cues['analysis'],'accents':len(cues['accents']),
                          'phrases':cues['phrases']},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
