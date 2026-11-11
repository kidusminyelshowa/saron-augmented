import cv2, numpy as np
photo=cv2.resize(cv2.imread('/home/claude/saron-augmented/tools/targets/mural-001/wall-photo.jpg'),(720,1170))
def prep(img):
  g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY).astype(np.float32)
  g=cv2.GaussianBlur(g,(0,0),2)
  gx=cv2.Sobel(g,cv2.CV_32F,1,0); gy=cv2.Sobel(g,cv2.CV_32F,0,1)
  m=np.sqrt(gx*gx+gy*gy); return m/(m.max()+1e-6)
P=prep(photo)
for l in ['background','logs','woman','ensira','water','hand']:
  im=cv2.imread(f'{l}.png'); c=im[:1170]; a=cv2.cvtColor(im[1170:2340],cv2.COLOR_BGR2GRAY)
  L=prep(c)
  m=((a>128)*255).astype(np.uint8); m=cv2.erode(m,np.ones((9,9),np.uint8)); m[880:]=0; m[:,670:]=0
  if l=='background': m[:]=0; m[:560,:670]=255
  W=np.array([[1,0,0],[0,1,0]],np.float32)
  try:
    cc,W=cv2.findTransformECC(P,L,W,cv2.MOTION_AFFINE,(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,300,1e-6),m,5)
  except cv2.error as e: print(l,'fail'); continue
  # W maps layer->photo coordinates? ECC: template=P, input=L; warp maps template coords to input coords: L(W*x)=P(x)
  Wi=cv2.invertAffineTransform(W)  # layer -> photo
  print(f'{l:11s} cc {cc:.3f}  A {Wi[:,:2].round(4).tolist()}  t {Wi[:,2].round(1).tolist()}')
