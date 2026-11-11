"""Build a deterministic 50 Hz light score from drums and full-mix dynamics.

Run separate_drums.py and track_meter.py first. Beat This! models beat/downbeat
evidence; a meter decoder fixes cadence before real drum attacks refine timing.
NumPy/SciPy perform band onset analysis offline. Only packed light channels go
to the browser, never models or stems. Instrument labels are band estimates.
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
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from audio_tracks import catalog_tracks
from meter_score import decode_meter, meter_pulses
from drum_details import arrange_details
from music_context import analyze_context

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
                event['prominence'] = round(float(peak / max(np.percentile(high,90),1e-6)),4)
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


def make_phrases(features, beats, duration, global_tempo, downbeats=None):
    spans=active_spans(features['activity'],features['events'],duration)
    phrases=[]; cursor=0
    overall_energy=float(np.percentile(features['mix_rms'],80))
    for a,b in spans:
        if a>cursor:phrases.append({'start':cursor,'end':a,'kind':'quiet'})
        local_beats=[t for t in beats if a<=t<b]
        # Four-bar groups. Boundaries are musical beat positions, not seconds.
        local_bars=[t for t in downbeats or [] if a<=t<b]
        boundaries=[a]+(local_bars[4::4] if local_bars else local_beats[16::16])+[b]
        if len(boundaries)>2 and boundaries[-1]-boundaries[-2]<1.8:boundaries.pop(-2)
        for lo,hi in zip(boundaries,boundaries[1:]):
            samples=features['mix_rms'][int(lo*RATE/HOP):int(hi*RATE/HOP)]
            hits=[e for e in features['events'] if e['type']!='cymbal' and lo<=e['time']<hi]
            energy=float(np.mean(samples)/max(overall_energy,1e-6)) if len(samples) else 0
            rate=len(hits)/max(hi-lo,.1)
            kind='dense' if energy>.94 and rate>3.8 else 'groove'
            phrases.append({'start':lo,'end':hi,'kind':kind,'energy':min(1.4,energy),'density':round(rate,2)})
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
    previous=None
    for phrase in output:
        phrase['start']=round(phrase['start'],4);phrase['end']=round(phrase['end'],4)
        if phrase['kind']=='quiet':
            samples=features['mix_rms'][int(phrase['start']*RATE/HOP):int(phrase['end']*RATE/HOP)]
            phrase['energy']=min(1.4,float(np.mean(samples))/max(overall_energy,1e-6)) if len(samples) else 0
            phrase['density']=0
        phrase['energy']=round(phrase['energy'],4)
        # Related passages repeat a related pose. Small feature fluctuations
        # retain the previous motif rather than cycling every four bars.
        kind,energy,density=phrase['kind'],phrase['energy'],phrase['density']
        style=0 if kind=='quiet' or energy<.68 or density<1.5 else 2 if kind=='dense' else 3 if kind=='fill' or density>=3.8 else 1
        if previous and kind==previous['kind'] and abs(energy-previous['energy'])<.12 and abs(density-previous['density'])<.65:
            style=previous['style']
        phrase['style']=style
        # A section entrance needs a real strong drum attack. Continuous
        # passages also require a marked energy rise AND a nearby crash.
        if previous and kind not in ['quiet','fill']:
            attacks=[e for e in features['events'] if e['type'] in ['kick','snare']
                     and phrase['start']<=e['time']<min(phrase['end'],phrase['start']+.6)
                     and e['strength']>=(.32 if e['type']=='kick' else .45)]
            after_break=previous['kind']=='quiet' and previous['end']-previous['start']>=1.5
            rising=energy-previous['energy']>=.16 and density>=previous['density']*.9
            for event in attacks:
                crash=any(e['type']=='cymbal' and e.get('crash') and abs(e['time']-event['time'])<.12 for e in features['events'])
                if after_break or (rising and crash):
                    phrase['entrance']=round(event['time'],4)
                    break
        previous=phrase
    return output


def phrase_at(phrases,time):
    return next((p for p in phrases if p['start']<=time<p['end']),phrases[-1])


def arrange_accents(events, phrases, beats, pulse_grid=None):
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
    slots=pulse_grid if pulse_grid is not None else [
        {'time':t,'period':beat_period*stride} for index,t in enumerate(beats) if index%stride==0]
    for slot in slots:
        t=slot['time']
        p=phrase_at(phrases,t)
        if p['kind']=='quiet':continue
        radius=min(.055,beat_period*.18)
        # Filter each real attack against the slot before picking one. Merging
        # first allowed a louder offbeat to erase a quieter, correctly timed hit.
        nearby=[e for e in candidates if abs(e['time']-t)<=radius]
        if not nearby:continue
        e=min(nearby,key=lambda e:(abs(e['time']-t)/radius)-.12*e['weight'])
        minimum=max(.42,slot['period']*.65) if pulse_grid is not None else max(.30,beat_period*.78)
        if not chosen or e['time']-chosen[-1]['time']>=minimum:chosen.append(e)
    # A genuine section entrance can fall between two tracker slots. Keep its
    # actual attack time, replacing a nearby regular accent rather than adding
    # an extra flash on the estimated phrase boundary.
    for p in phrases:
        if 'entrance' not in p:continue
        # Once meter is available, entrances also respect the planned pulse.
        # A loud offbeat is not permitted to restart the main light cadence.
        if pulse_grid is not None:
            entry=[a for a in chosen if abs(a['time']-p['entrance'])<.065]
        else:entry=[e for e in merged if abs(e['time']-p['entrance'])<.065]
        if entry:
            e=min(entry,key=lambda e:abs(e['time']-p['entrance']))
            chosen=[a for a in chosen if abs(e['time']-a['time'])>=max(.42 if pulse_grid is not None else .30,beat_period*.78)]
            chosen.append(e)
    accents=[]
    for e in sorted(chosen,key=lambda e:e['time']):
        p=e['phrase'];kind=e['type']
        if p['kind']=='fill':kind='fill'
        if 'entrance' in p and abs(e['time']-p['entrance'])<.065:kind='impact'
        side=-1
        if pulse_grid is None:
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


def bake_score(features,phrases,accents,events,beats,tempo,duration,details=None):
    times=np.arange(int(np.ceil(duration*FPS))+1)/FPS;n=len(times)
    mix=normalize(np.interp(times,np.arange(len(features['mix_rms']))*HOP/RATE,features['mix_rms'])**.65)
    base=np.full(n,.30);period=np.full(n,28.);amplitude=np.full(n,10.);bias=np.zeros(n)
    separation=np.zeros(n); stereo=np.zeros(n)
    for p in phrases:
        keep=(times>=p['start'])&(times<=p['end']);kind=p['kind'];style=p['style']
        energy=np.clip(p.get('energy',.8),0,1.3)
        if kind=='quiet':base[keep]=.265+.04*min(1,energy);period[keep]=31;amplitude[keep]=9.5
        elif kind=='groove':base[keep]=.315+.055*energy;period[keep]=np.clip(48*60/tempo,20,28);amplitude[keep]=13+2*min(1,energy)
        elif kind=='dense':base[keep]=.355+.055*energy;period[keep]=np.clip(48*60/tempo,19,24);amplitude[keep]=16.5
        else:base[keep]=.33+.055*energy;period[keep]=20;amplitude[keep]=15.5
        bias[keep]=[0,.8,-.8,0][style]
        separation[keep]=[.12,1.35,2.8,-1.1][style] if kind!='quiet' else .28
        stereo[keep]=[0,1,-1,.6][style] if kind!='quiet' else 0
    base=ndimage.gaussian_filter1d(base,.5*FPS)
    speed=ndimage.gaussian_filter1d(2*np.pi/period,.8*FPS)
    amplitude=ndimage.gaussian_filter1d(amplitude,.8*FPS)
    bias=ndimage.gaussian_filter1d(bias,.8*FPS)
    separation=ndimage.gaussian_filter1d(separation,2.8*FPS)
    stereo=ndimage.gaussian_filter1d(stereo,1.2*FPS)
    # Full-mix context is deliberately a slow, low-amplitude layer. It cannot
    # schedule accents, change pulse envelopes or alter the sweep phase/speed.
    context=features.get('context')
    context_haze=np.zeros(n)
    if context is not None:
        energy=np.interp(times,np.arange(len(context['energy']))/FPS,context['energy'])
        brightness=np.interp(times,np.arange(len(context['brightness']))/FPS,context['brightness'])
        texture=np.interp(times,np.arange(len(context['texture']))/FPS,context['texture'])
        base+=.035*(energy-.6)+.012*(texture-.25)
        amplitude+=1.5*(energy-.6)+.8*(texture-.25)
        context_haze=.025*(energy-.6)+.025*(texture-.25)+.02*(brightness-.6)
    phase=1+np.cumsum(speed)/FPS
    # The continuous bed follows broad musical dynamics; attack transients
    # still belong exclusively to the separated drum events below.
    breath=.012*np.sin(times*2*np.pi/8)+.035*(smooth(mix,.65,FPS)-.6)
    left=base+breath+.035*stereo;right=base+breath-.035*stereo
    pulse_l=np.zeros(n);pulse_r=np.zeros(n)
    entry_wash=np.zeros(n)
    for a in accents:
        kind=a['type'];strength=a['strength'];side=a['side']
        attack,hold,release={'kick':(.012,.025,.095),'snare':(.010,.02,.065),
                            'fill':(.010,.02,.075),'impact':(.015,.09,.24)}[kind]
        phrase=phrase_at(phrases,a['time'])
        variation=[.92,1.,1.08,.97][phrase['style']]
        hold*=variation;release*=variation
        peak=(.43+.17*strength)*([.97,1.,1.03,1.][phrase['style']])
        l,r=1.,1.
        if side==0:r=.35
        if side==1:l=.35
        # Peak at the decoded drum attack, rather than starting a slow rise
        # there and adding another 25–40ms of visible delay.
        onset=max(0,a['time']-attack)
        add_envelope(pulse_l,onset,peak*l,attack,hold,release)
        add_envelope(pulse_r,onset,peak*r,attack,hold,release)
        if kind=='impact':
            # A restrained intake before an actual entrance, then a broader
            # shared glow. Neither creates a new beat or resets the head phase.
            until=a['time']-times
            intake=np.where((until>attack)&(until<.42),np.sin(np.pi*(until-attack)/(.42-attack))**2,0)
            left-=.045*intake;right-=.045*intake
            add_envelope(entry_wash,onset,.075,attack,.10,.55)
    # Detail gestures have their own lower dynamic range. They answer the main
    # cadence without moving, replacing or resetting any of its pulse times.
    detail_l=np.zeros(n);detail_r=np.zeros(n);bloom=np.zeros(n);spread=np.zeros(n)
    for detail in details or []:
        kind=detail['type'];t=detail['time'];strength=detail['strength']
        if kind=='cymbal':
            nearest=min(accents,key=lambda a:abs(a['time']-t)) if accents else None
            if nearest is not None and abs(nearest['time']-t)<=.08:
                # Reinforce an existing main hit, never make a nearby second
                # flash. Off-cadence crashes stay in haze and slow opening.
                add_envelope(bloom,max(0,nearest['time']-.015),.09+.065*strength,.015,.045,.18)
            add_envelope(spread,max(0,t-.12),1.,.12,.04,.32)
        elif kind=='cymbal-texture':
            add_envelope(bloom,max(0,t-.035),.02+.02*strength,.035,.01,.10)
        else:
            channel=detail_l if detail['side']==0 else detail_r
            peak=(.14+.065*strength) if kind=='backbeat' else (.17+.065*strength)
            add_envelope(channel,max(0,t-.01),peak,.01,.02,.065 if kind=='backbeat' else .055)
    pulse_l=np.maximum(pulse_l,detail_l);pulse_r=np.maximum(pulse_r,detail_r)
    # Busy snare rolls belong to the diffuse room light. Adding independent
    # direct-beam flashes here made fast songs switch between the main cadence
    # and intervening backbeats, even when the main score was correctly locked.
    percussion_wash=np.zeros(n)
    for event in events:
        t=event['time']; p=phrase_at(phrases,t)
        if event['type']!='snare' or event['strength']<.3 or p['kind']=='quiet':continue
        add_envelope(percussion_wash,t,.035*event['strength'],.15,.05,.22)
    # The final decay follows the recorded fade/silence, not a fixed timer, so
    # a track that cuts hard on its last hit keeps that hit intact.
    end_window=times>max(0,duration-4)
    tail=np.ones(n)
    if np.median(mix[end_window][-min(int(.5*FPS),sum(end_window)):])<.22:
        blend=np.clip((times-max(0,duration-4))/.8,0,1)
        blend=blend*blend*(3-2*blend)
        tail=1-.3*blend*(1-np.clip(smooth(mix,.25,FPS)/.35,0,1))
    left=np.clip(left*tail+pulse_l+bloom,.25,.98);right=np.clip(right*tail+pulse_r+bloom,.25,.98)
    wash=np.zeros(n)
    for event in events:
        if event['type']=='cymbal' and event.get('crash'):
            add_envelope(wash,event['time'],.07+.07*event['strength'],.08,.08,.45)
    haze=np.clip(.36+.14*smooth(mix,.65,FPS)+context_haze+wash+entry_wash+smooth(percussion_wash,.2,FPS)+.12*smooth(np.maximum(pulse_l,pulse_r),.16,FPS),.34,.86)
    center=132.5
    # Strong sustained cymbals open the two beams gently; no fast head jumps.
    opening=smooth(spread,.15,FPS)*1.6
    angle_l=center+amplitude*np.sin(phase)+bias*.3-opening
    angle_r=center+amplitude*np.sin(phase+separation)+bias*.3+opening
    # Bound head velocity across phrase transitions. Sampling remains seekable
    # because the slew is baked offline, never accumulated by the browser.
    for channel in [angle_l,angle_r]:
        for i in range(1,n):channel[i]=np.clip(channel[i],channel[i-1]-.16,channel[i-1]+.16)
    channels={'left':encode(left),'right':encode(right),'haze':encode(haze),
              'angleLeft':encode((np.clip(angle_l,115,150)-115)/35),
              'angleRight':encode((np.clip(angle_r,115,150)-115)/35)}
    return channels


def analyze(stem,mix,duration=None,meter=None):
    duration=duration or len(mix)/RATE
    # Separator output must share the decoded source's sample origin and length.
    stem=np.pad(stem,(0,max(0,len(mix)-len(stem))))[:len(mix)]
    features=extract_drums(stem,mix)
    features['context']=analyze_context(mix,RATE,FPS)
    decoded=None;pulse_grid=None
    if meter is not None:
        if abs(meter['duration']-duration)>.06:raise ValueError('Meter duration does not match audio')
        beats=meter['beats']
        decoded=decode_meter(beats,meter['downbeatProbability'],meter['fps'])
        # Preserve the approved v6 cadence; detail/context layers never feed
        # back into meter selection or the matched main drum attacks.
        pulse_grid=meter_pulses(beats,decoded['phases'])
        intervals=np.diff(beats)
        tempo=60/float(np.median(intervals)) if len(intervals) else 120.
        tempo_points=[{'time':round(t,3),'bpm':round(60/float(np.median(intervals[max(0,i-6):i+7])),2)}
                      for i,t in enumerate(beats[:-1]) if i%4==0]
    else:beats,tempo_points,tempo=track_beats(features['onset'])
    phrases=make_phrases(features,beats,duration,tempo,decoded['barstarts'] if decoded else None)
    accents=arrange_accents(features['events'],phrases,beats,pulse_grid)
    details=arrange_details(features['events'],phrases,beats,decoded['phases'],pulse_grid,accents) if decoded else []
    for phrase in phrases:
        start=int(phrase['start']*FPS);end=max(start+1,int(phrase['end']*FPS))
        phrase['context']={name:round(float(values[start:end].mean()),3)
                           for name,values in features['context'].items()}
    channels=bake_score(features,phrases,accents,features['events'],beats,tempo,duration,details)
    counts={kind:sum(e['type']==kind for e in features['events']) for kind in ['kick','snare','cymbal']}
    cues={'version':3,'duration':round(duration,4),'fps':FPS,'encoding':'u8-base64','channels':channels,
          'beats':beats,'tempo':tempo_points,'phrases':phrases,'accents':accents,'details':details,
          'analysis':{'separator':'htdemucs','method':'drum-stem/band-attacks/meter-cadence/phrase-score' if meter else 'drum-stem/band-attacks/dynamic-beat-tracking/phrase-score','phraseLabels':'estimated',
                      'instrumentLabels':'estimated','tempo':round(tempo,2),'events':counts,
                      'musicContext':'full-mix/slow-energy-brightness-texture',
                      'crashes':sum(e.get('crash',False) for e in features['events']),
                      'stemOffsetSamples':0,'stemSampleRate':RATE,'arrangement':7}}
    if decoded is not None:
        cues['downbeats']=decoded['barstarts']
        cues['cadence']=pulse_grid
        cues['analysis']['meter']={'model':meter['model'],'method':'four-state-viterbi/nearest-real-drum',
            'beatsPerBar':4,'phaseChanges':len(decoded['phaseChanges']),
            'maximumSnapSeconds':.055,'minimumPulseSeconds':.42,
            'checkpointSha256':meter.get('checkpointSha256')}
    return cues,features


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--stems',type=pathlib.Path,required=True)
    sources=catalog_tracks()
    parser.add_argument('--track',choices=list(sources),action='append')
    parser.add_argument('--all',action='store_true')
    parser.add_argument('--diagnostics',type=pathlib.Path)
    parser.add_argument('--meter',type=pathlib.Path,help='Cached Beat This! results from track_meter.py')
    args=parser.parse_args()
    for slug in (list(sources) if args.all else args.track or TRACKS):
        mp3=sources[slug];stem_path=args.stems/f'{slug}.wav'
        mix,stem=decode(mp3),decode(stem_path)
        source_sha=hashlib.sha256(mp3.read_bytes()).hexdigest()
        meter=json.loads((args.meter/f'{slug}.json').read_text()) if args.meter else None
        if meter is not None and meter['sourceSha256']!=source_sha:raise ValueError('Meter source hash mismatch: '+slug)
        cues,features=analyze(stem,mix,meter=meter)
        cues['analysis']['sourceSha256']=source_sha
        mp3.with_suffix('.json').write_text(json.dumps(cues,separators=(',',':'))+'\n')
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
