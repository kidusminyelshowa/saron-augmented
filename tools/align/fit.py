import cv2, numpy as np, sys
photo=cv2.resize(cv2.imread('/home/claude/saron-augmented/tools/targets/mural-001/wall-photo.jpg'),(720,1170))
pg=cv2.cvtColor(photo,cv2.COLOR_BGR2GRAY)
pmask=np.zeros_like(pg); pmask[:880,:670]=255   # skip the fake teal bottom and the drainpipe
sift=cv2.SIFT_create(6000)
clahe=cv2.createCLAHE(2.0,(8,8))
kp,dp=sift.detectAndCompute(clahe.apply(pg),pmask)
def load(l):
  im=cv2.imread(f'{l}.png'); c=im[:1170]; a=cv2.cvtColor(im[1170:2340],cv2.COLOR_BGR2GRAY)
  return c,a
def fit(l, comp_bg=False):
  c,a=load(l)
  g=cv2.cvtColor(c,cv2.COLOR_BGR2GRAY)
  m=((a>128)*255).astype(np.uint8); m=cv2.erode(m,np.ones((7,7),np.uint8))
  m[880:]=0
  k,d=sift.detectAndCompute(clahe.apply(g),m)
  if d is None: return None
  ms=cv2.BFMatcher().knnMatch(d,dp,k=2)
  good=[x for x,y in ms if x.distance<0.8*y.distance]
  P=np.float32([k[x.queryIdx].pt for x in good]); Q=np.float32([kp[x.trainIdx].pt for x in good])
  # RANSAC fit of axis-aligned scale+translate: q = s*p + t
  best=None; rng=np.random.default_rng(0)
  for _ in range(3000):
    i,j=rng.choice(len(P),2,replace=False)
    dp_=P[i]-P[j]; dq=Q[i]-Q[j]
    if abs(dp_[0])<30 or abs(dp_[1])<30: continue
    s=dq/dp_; 
    if np.any(s<0.85) or np.any(s>1.15): continue
    t=Q[i]-s*P[i]
    r=np.linalg.norm(Q-(P*s+t),axis=1); inl=r<4
    if best is None or inl.sum()>best[0].sum(): best=(inl,s,t)
  if best is None:
    print(l,"no fit",len(good)); return None
  inl=best[0]
  # least squares refine per axis
  s=[];t=[]
  for ax in (0,1):
    A=np.stack([P[inl,ax],np.ones(inl.sum())],1); sol=np.linalg.lstsq(A,Q[inl,ax],rcond=None)[0]; s.append(sol[0]); t.append(sol[1])
  s=np.array(s); t=np.array(t)
  r=np.linalg.norm(Q[inl]-(P[inl]*s+t),axis=1)
  r0=np.linalg.norm(Q[inl]-P[inl],axis=1)
  print(f'{l:11s} matches {len(good):4d} inliers {inl.sum():3d}  scale {s.round(4)}  shift_px {t.round(1)}  err before {r0.mean():.1f}px after {r.mean():.1f}px')
  return s,t,inl.sum()
res={}
for l in sys.argv[1:]:
  res[l]=fit(l)
np.save('fits.npy',res,allow_pickle=True)

def aff(l):
  c,a=load(l); g=cv2.cvtColor(c,cv2.COLOR_BGR2GRAY)
  m=((a>128)*255).astype(np.uint8); m=cv2.erode(m,np.ones((7,7),np.uint8)); m[880:]=0
  k,d=sift.detectAndCompute(clahe.apply(g),m)
  ms=cv2.BFMatcher().knnMatch(d,dp,k=2); good=[x for x,y in ms if x.distance<0.8*y.distance]
  P=np.float32([k[x.queryIdx].pt for x in good]); Q=np.float32([kp[x.trainIdx].pt for x in good])
  A,inl=cv2.estimateAffine2D(P,Q,ransacReprojThreshold=4,maxIters=5000)
  print('AFF',l,inl.sum(),A.round(4).tolist())
for l in sys.argv[1:]:
  try: aff(l)
  except Exception as e: print(l,e)
