import cv2, numpy as np, json
photo=cv2.resize(cv2.imread('/home/claude/saron-augmented/tools/targets/mural-001/wall-photo.jpg'),(720,1170))
def prep(img):
  g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY).astype(np.float32); g=cv2.GaussianBlur(g,(0,0),1.5)
  m=np.hypot(cv2.Sobel(g,cv2.CV_32F,1,0),cv2.Sobel(g,cv2.CV_32F,0,1)); return m
P=prep(photo)
I=np.array([[1,0,0],[0,1,0]],np.float32)
cands={
 'background':{'id':I,'sift_aff':[[0.9862,0.0119,0.7413],[-0.0158,0.9959,1.7869]],'ecc':[[0.996,-0.0098,2.1],[-0.0155,0.996,2.3]],'sift_s':[[0.9879,0,2.5],[0,0.9804,-0.4]]},
 'logs':{'id':I,'sift_aff':[[0.9862,-0.0189,12.6485],[-0.0095,1.0145,-4.6879]],'ecc':[[0.9837,0.0017,1.0],[-0.0154,1.0108,1.8]],'sift_s':[[0.9816,0,3.4],[0,1.0045,-4.0]]},
 'woman':{'id':I,'sift_aff':[[0.9324,-0.008,24.81],[-0.0014,0.9925,3.99]],'ecc':[[1.0075,0.001,-10.4],[-0.0008,1.0206,-13.1]],'sift_s':[[1.0083,0,-11.0],[0,1.0185,-10.5]]},
 'hand':{'id':I,'sift_aff':[[1.0074,-0.0178,4.71],[-0.0224,0.9948,16.58]],'ecc':[[0.9954,-0.009,1.4],[-0.022,0.9994,13.4]],'sift_s':[[1.0074,0,-7.7],[0,0.981,18.7]]},
}
def score(l,A):
  im=cv2.imread(f'{l}.png'); c=im[:1170]; a=im[1170:2340,:,0]
  A=np.float32(A)
  cw=cv2.warpAffine(c,A,(720,1170)); aw=cv2.warpAffine(a,A,(720,1170))
  m=cv2.erode(((aw>128)).astype(np.uint8),np.ones((9,9),np.uint8)).astype(bool); m[880:]=False; m[:,670:]=False
  L=prep(cw); x=P[m]-P[m].mean(); y=L[m]-L[m].mean()
  return float((x*y).sum()/np.sqrt((x*x).sum()*(y*y).sum()))
for l,cs in cands.items():
  print(l,{k:round(score(l,v),4) for k,v in cs.items()})
